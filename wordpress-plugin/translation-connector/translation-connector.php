<?php
/**
 * Plugin Name: TTW Translation Connector
 * Description: Sends signed article events to the central TTW translation platform.
 * Version: 0.1.0
 * Requires at least: 6.1
 * Requires PHP: 7.4
 */
if (!defined('ABSPATH')) { exit; }

function ttw_translation_table() {
    global $wpdb;
    return $wpdb->prefix . 'ttw_translation_outbox';
}

add_filter('cron_schedules', function ($schedules) {
    $schedules['ttw_translation_minute'] = array('interval' => 60, 'display' => 'Every minute');
    return $schedules;
});

register_activation_hook(__FILE__, function () {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = ttw_translation_table();
    $charset = $wpdb->get_charset_collate();
    dbDelta("CREATE TABLE $table (
        id bigint unsigned NOT NULL AUTO_INCREMENT,
        request_id char(36) NOT NULL,
        post_id bigint unsigned NOT NULL,
        payload longtext NOT NULL,
        attempts int unsigned NOT NULL DEFAULT 0,
        run_at bigint unsigned NOT NULL,
        state varchar(12) NOT NULL DEFAULT 'pending',
        last_code int NOT NULL DEFAULT 0,
        PRIMARY KEY  (id),
        UNIQUE KEY request_id (request_id),
        KEY ready (state,run_at,id)
    ) $charset;");
    if (!wp_next_scheduled('ttw_translation_outbox_run')) {
        wp_schedule_event(time() + 60, 'ttw_translation_minute', 'ttw_translation_outbox_run');
    }
});

register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook('ttw_translation_outbox_run');
});

function ttw_translation_enqueue($post, $status) {
    global $wpdb;
    $post_id = $post->ID;
    $canonical = wp_get_canonical_url($post_id) ?: get_permalink($post_id);
    $image = get_post_thumbnail_id($post_id);
    $categories = wp_get_post_terms($post_id, 'category', array('fields' => 'names'));
    $tags = wp_get_post_terms($post_id, 'post_tag', array('fields' => 'names'));
    $payload = array(
        'postId' => (string) $post_id,
        'sourceHost' => wp_parse_url(home_url(), PHP_URL_HOST),
        'title' => html_entity_decode(wp_strip_all_tags($post->post_title), ENT_QUOTES, 'UTF-8'),
        'content' => $post->post_content,
        'excerpt' => wp_strip_all_tags($post->post_excerpt),
        'featuredImage' => get_the_post_thumbnail_url($post_id, 'full') ?: '',
        'imageAlt' => $image ? (string) get_post_meta($image, '_wp_attachment_image_alt', true) : '',
        'author' => get_the_author_meta('display_name', (int) $post->post_author),
        'categories' => is_wp_error($categories) ? array() : $categories,
        'tags' => is_wp_error($tags) ? array() : $tags,
        'slug' => $post->post_name,
        'publishedAt' => get_post_time(DATE_ATOM, true, $post),
        'modifiedAt' => gmdate('Y-m-d\TH:i:s') . sprintf('.%03dZ', (int) (microtime(true) * 1000) % 1000),
        'status' => $status,
        'canonical' => $canonical,
        'seoTitle' => (string) get_post_meta($post_id, '_yoast_wpseo_title', true),
        'seoDescription' => (string) get_post_meta($post_id, '_yoast_wpseo_metadesc', true),
        'language' => str_replace('_', '-', get_locale()),
        'articleType' => $post->post_type,
    );
    $encoded = wp_json_encode($payload);
    if ($encoded === false || !$wpdb->insert(ttw_translation_table(), array(
        'request_id' => wp_generate_uuid4(), 'post_id' => $post_id,
        'payload' => $encoded, 'run_at' => time(),
    ))) {
        error_log('TTW Translation Connector could not store an article event for post ' . (int) $post_id);
    }
}

add_action('wp_after_insert_post', function ($post_id, $post, $update, $before) {
    if ($post->post_type !== 'post' || wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) { return; }
    if ($post->post_status === 'publish') {
        ttw_translation_enqueue($post, 'publish');
    } elseif ($update && $before && $before->post_status === 'publish') {
        ttw_translation_enqueue($post, 'withdrawn');
    }
}, 20, 4);

add_action('before_delete_post', function ($post_id, $post) {
    if ($post->post_type === 'post' && $post->post_status === 'publish') {
        ttw_translation_enqueue($post, 'withdrawn');
    }
}, 10, 2);

add_action('ttw_translation_outbox_run', function () {
    if (!defined('TTW_TRANSLATION_ENDPOINT') || !defined('TTW_TRANSLATION_API_KEY') || !defined('TTW_TRANSLATION_SECRET')) { return; }
    $scheme = wp_parse_url(TTW_TRANSLATION_ENDPOINT, PHP_URL_SCHEME);
    if ($scheme !== 'https' && !(wp_get_environment_type() === 'local' && $scheme === 'http')) { return; }
    global $wpdb;
    $table = ttw_translation_table();
    $now = time();
    $batch = $wpdb->get_results($wpdb->prepare(
        "SELECT * FROM $table WHERE state IN ('pending','sending') AND run_at<=%d ORDER BY id LIMIT 20", $now
    ));
    foreach ($batch as $event) {
        $lease = time() + 90;
        $claimed = $wpdb->query($wpdb->prepare(
            "UPDATE $table SET state='sending',run_at=%d WHERE id=%d AND state IN ('pending','sending') AND run_at<=%d",
            $lease, $event->id, time()
        ));
        if ($claimed !== 1) { continue; }
        $timestamp = (string) time();
        $signature = hash_hmac('sha256', "$timestamp.$event->request_id." . $event->payload, TTW_TRANSLATION_SECRET);
        $response = wp_remote_post(TTW_TRANSLATION_ENDPOINT, array(
            'timeout' => 8, 'redirection' => 0, 'body' => $event->payload,
            'headers' => array(
                'Content-Type' => 'application/json', 'X-Api-Key' => TTW_TRANSLATION_API_KEY,
                'X-Timestamp' => $timestamp, 'X-Request-Id' => $event->request_id, 'X-Signature' => $signature,
            ),
        ));
        $code = is_wp_error($response) ? 0 : wp_remote_retrieve_response_code($response);
        if ($code >= 200 && $code < 300) {
            $wpdb->delete($table, array('id' => $event->id, 'state' => 'sending', 'run_at' => $lease));
            continue;
        }
        $attempts = (int) $event->attempts + 1;
        $retry = $attempts < 12 && ($code < 200 || $code === 429 || $code >= 500);
        $wpdb->update($table, array(
            'state' => $retry ? 'pending' : 'failed', 'attempts' => $attempts,
            'run_at' => time() + min(21600, 60 * (2 ** min($attempts - 1, 9))), 'last_code' => $code,
        ), array('id' => $event->id, 'state' => 'sending', 'run_at' => $lease));
    }
});

add_action('admin_menu', function () {
    add_management_page('Translation Connector', 'Translation Connector', 'manage_options', 'ttw-translation', function () {
        if (!current_user_can('manage_options')) { return; }
        global $wpdb;
        $table = ttw_translation_table();
        $events = $wpdb->get_results("SELECT id,post_id,state,attempts,last_code FROM $table ORDER BY id DESC LIMIT 100");
        echo '<div class="wrap"><h1>Translation Connector</h1><p>Pending deliveries and failed requests.</p>';
        echo '<table class="widefat striped"><thead><tr><th>Post</th><th>Status</th><th>Attempts</th><th>HTTP status</th><th>Action</th></tr></thead><tbody>';
        foreach ($events as $event) {
            echo '<tr><td>' . esc_html($event->post_id) . '</td><td>' . esc_html($event->state) . '</td><td>' . esc_html($event->attempts);
            echo '</td><td>' . esc_html($event->last_code) . '</td><td>';
            if ($event->state === 'failed') {
                $url = wp_nonce_url(add_query_arg(array('action' => 'ttw_translation_resend', 'id' => $event->id), admin_url('admin-post.php')), 'ttw_translation_resend_' . $event->id);
                echo '<a href="' . esc_url($url) . '">Retry delivery</a>';
            }
            echo '</td></tr>';
        }
        echo '</tbody></table></div>';
    });
});

add_action('admin_post_ttw_translation_resend', function () {
    if (!current_user_can('manage_options')) { wp_die('Permission denied'); }
    $id = isset($_GET['id']) ? absint($_GET['id']) : 0;
    check_admin_referer('ttw_translation_resend_' . $id);
    global $wpdb;
    $wpdb->update(ttw_translation_table(), array('attempts' => 0, 'state' => 'pending', 'run_at' => time()), array('id' => $id, 'state' => 'failed'));
    wp_safe_redirect(admin_url('tools.php?page=ttw-translation'));
    exit;
});
