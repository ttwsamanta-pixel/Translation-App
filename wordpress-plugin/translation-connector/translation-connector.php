<?php
/**
 * Plugin Name: TTW Translation Connector
 * Description: Sends signed article events to the central TTW translation platform.
 * Version: 0.3.0
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

function ttw_translation_install() {
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
        created_at bigint unsigned NOT NULL DEFAULT 0,
        delivered_at bigint unsigned NOT NULL DEFAULT 0,
        article_id bigint unsigned NOT NULL DEFAULT 0,
        response_note varchar(500) NOT NULL DEFAULT '',
        payload_hash char(64) NOT NULL DEFAULT '',
        delivery_mode varchar(12) NOT NULL DEFAULT '',
        PRIMARY KEY  (id),
        UNIQUE KEY request_id (request_id),
        KEY ready (state,run_at,id),
        KEY post_events (post_id,id),
        KEY delivered (state,delivered_at,id)
    ) $charset;");
    if (!wp_next_scheduled('ttw_translation_outbox_run')) {
        wp_schedule_event(time() + 60, 'ttw_translation_minute', 'ttw_translation_outbox_run');
    }
    update_option('ttw_translation_db_version', '2', false);
}

register_activation_hook(__FILE__, 'ttw_translation_install');
add_action('plugins_loaded', function () {
    if (get_option('ttw_translation_db_version') !== '2') { ttw_translation_install(); }
});

register_deactivation_hook(__FILE__, function () {
    wp_clear_scheduled_hook('ttw_translation_outbox_run');
    wp_unschedule_hook('ttw_translation_sync_pages');
});

function ttw_translation_settings() {
    return wp_parse_args(get_option('ttw_translation_settings', array()), array(
        'url' => '', 'key' => '', 'secret' => '', 'site_id' => '',
        'updates' => true, 'revision_saves' => true, 'unchanged' => false,
        'excerpt' => true, 'image' => true, 'seo' => true, 'tags' => true, 'author' => true, 'category' => true,
    ));
}

function ttw_translation_connection($operation = 'article') {
    $settings = ttw_translation_settings();
    $endpoint = defined('TTW_TRANSLATION_ENDPOINT')
        ? TTW_TRANSLATION_ENDPOINT
        : rtrim($settings['url'], '/') . '/api/v1/webhooks/wordpress/article';
    if (in_array($operation, array('test', 'categories'), true)) {
        $endpoint = preg_replace('~/article(?:/update)?/?$~', '/' . $operation, $endpoint);
    }
    $key = defined('TTW_TRANSLATION_API_KEY') ? TTW_TRANSLATION_API_KEY : $settings['key'];
    $secret = defined('TTW_TRANSLATION_SECRET') ? TTW_TRANSLATION_SECRET : $settings['secret'];
    return array($endpoint, $key, $secret);
}

function ttw_translation_request($body, $request_id, $operation = 'article') {
    list($endpoint, $key, $secret) = ttw_translation_connection($operation);
    $scheme = wp_parse_url($endpoint, PHP_URL_SCHEME);
    $configured_endpoint = $operation === 'article' || substr($endpoint, -strlen('/webhooks/wordpress/' . $operation)) === '/webhooks/wordpress/' . $operation;
    if (!$configured_endpoint || !$key || !$secret || !wp_parse_url($endpoint, PHP_URL_HOST)
        || ($scheme !== 'https' && !(wp_get_environment_type() === 'local' && $scheme === 'http'))) {
        return new WP_Error('ttw_not_configured', 'Configure the central site URL and credentials.');
    }
    $timestamp = (string) time();
    $arguments = array(
        'timeout' => 8, 'redirection' => 0, 'body' => $body, 'limit_response_size' => 8192,
        'headers' => array(
            'Content-Type' => 'application/json', 'X-Api-Key' => $key,
            'X-Timestamp' => $timestamp, 'X-Request-Id' => $request_id,
            'X-Signature' => hash_hmac('sha256', "$timestamp.$request_id." . $body, $secret),
        ),
    );
    // Local test installations can use their loopback address; production uses WordPress URL validation.
    return wp_get_environment_type() === 'local' ? wp_remote_post($endpoint, $arguments) : wp_safe_remote_post($endpoint, $arguments);
}

function ttw_translation_rules() {
    return get_option('ttw_translation_category_rules', array());
}

function ttw_translation_mode($post_id) {
    $rules = ttw_translation_rules();
    $modes = array();
    foreach (wp_get_post_categories($post_id) as $id) {
        if (isset($rules[$id])) {
            $modes[] = $rules[$id]['mode'];
            continue;
        }
        foreach (get_ancestors($id, 'category', 'taxonomy') as $ancestor) {
            if (isset($rules[$ancestor]) && !empty($rules[$ancestor]['children'])) {
                $modes[] = $rules[$ancestor]['mode'];
                break;
            }
        }
    }
    foreach (array('disabled', 'manual', 'automatic') as $mode) {
        if (in_array($mode, $modes, true)) { return $mode; }
    }
    return 'disabled';
}

function ttw_translation_payload($post, $status) {
    $settings = ttw_translation_settings();
    $post_id = $post->ID;
    $canonical = wp_get_canonical_url($post_id) ?: get_permalink($post_id);
    $image = get_post_thumbnail_id($post_id);
    $categories = $settings['category'] ? wp_get_post_terms($post_id, 'category') : array();
    $tags = $settings['tags'] ? wp_get_post_terms($post_id, 'post_tag', array('fields' => 'names')) : array();
    if (is_wp_error($categories)) { $categories = array(); }
    $categories = array_slice($categories, 0, 100);
    $metadata = $image && $settings['image'] ? wp_get_attachment_metadata($image) : array();
    $content = $post->post_content;
    if ($post->post_type === 'page') {
        $content = $status === 'withdrawn' ? '' : strip_shortcodes($content);
        if ($content !== '' && !has_blocks($content)) { $content = wpautop($content); }
    }
    $payload = array(
        'postId' => (string) $post_id,
        'sourceHost' => wp_parse_url(home_url(), PHP_URL_HOST),
        'title' => html_entity_decode(wp_strip_all_tags($post->post_title), ENT_QUOTES, 'UTF-8'),
        'content' => $content,
        'excerpt' => $settings['excerpt'] ? wp_strip_all_tags($post->post_excerpt) : '',
        'featuredImage' => $settings['image'] ? (get_the_post_thumbnail_url($post_id, 'full') ?: '') : '',
        'imageAlt' => $image && $settings['image'] ? (string) get_post_meta($image, '_wp_attachment_image_alt', true) : '',
        'author' => $settings['author'] ? (string) get_the_author_meta('display_name', (int) $post->post_author) : '',
        'categories' => wp_list_pluck($categories, 'name'),
        'tags' => is_wp_error($tags) ? array() : array_slice($tags, 0, 100),
        'slug' => $post->post_name,
        'publishedAt' => get_post_time(DATE_ATOM, true, $post),
        'modifiedAt' => gmdate('Y-m-d\TH:i:s') . sprintf('.%03dZ', (int) (microtime(true) * 1000) % 1000),
        'status' => $status,
        'canonical' => $canonical,
        'seoTitle' => $settings['seo'] ? (string) get_post_meta($post_id, '_yoast_wpseo_title', true) : '',
        'seoDescription' => $settings['seo'] ? (string) get_post_meta($post_id, '_yoast_wpseo_metadesc', true) : '',
        'language' => str_replace('_', '-', get_locale()),
        'articleType' => $post->post_type,
    );
    if ($settings['site_id'] !== '') { $payload['siteId'] = $settings['site_id']; }
    if ($settings['category']) {
        $payload['categoryIds'] = array_map('intval', wp_list_pluck($categories, 'term_id'));
    }
    if (!empty($metadata['width']) && !empty($metadata['height'])) {
        $payload['imageMetadata'] = array(
            'width' => absint($metadata['width']), 'height' => absint($metadata['height']),
            'mime' => (string) get_post_mime_type($image),
        );
    }
    return apply_filters('ttw_translation_article_payload', $payload, $post);
}

function ttw_translation_latest_event($post_id) {
    global $wpdb;
    $table = ttw_translation_table();
    return $wpdb->get_row($wpdb->prepare("SELECT * FROM $table WHERE post_id=%d ORDER BY id DESC LIMIT 1", $post_id));
}

function ttw_translation_fingerprint($payload) {
    unset($payload['modifiedAt']);
    foreach (array('tags', 'categories', 'categoryIds') as $field) {
        if (isset($payload[$field]) && is_array($payload[$field])) { sort($payload[$field]); }
    }
    ksort($payload);
    return hash('sha256', wp_json_encode($payload));
}

function ttw_translation_enqueue($post, $status, $mode, $force = false) {
    global $wpdb;
    $table = ttw_translation_table();
    $post_id = $post->ID;
    $payload = ttw_translation_payload($post, $status);
    $last = ttw_translation_latest_event($post_id);
    $hash = ttw_translation_fingerprint($payload);
    $previous = $last && !$last->payload_hash ? json_decode($last->payload, true) : null;
    $previous_hash = $last->payload_hash ?? '';
    if (!$previous_hash && is_array($previous)) { $previous_hash = ttw_translation_fingerprint($previous); }
    if ($previous_hash === $hash) {
        if (!$force && !ttw_translation_settings()['unchanged']) { return 'unchanged'; }
        if (in_array($last->state, array('pending', 'sending'), true)) { return 'unchanged'; }
    }
    $encoded = wp_json_encode($payload);
    $request_id = substr(hash('sha256', $table . '|' . $post_id . '|' . ($last ? $last->id : 0) . '|' . $hash), 0, 36);
    if ($encoded === false) { return 'failed'; }
    $inserted = $wpdb->query($wpdb->prepare(
        "INSERT INTO $table (request_id,post_id,payload,run_at,created_at,delivery_mode,payload_hash)
        VALUES (%s,%d,%s,%d,%d,%s,%s) ON DUPLICATE KEY UPDATE request_id=request_id",
        $request_id, $post_id, $encoded, time(), time(), $mode, $hash
    ));
    if ($inserted === false) {
        error_log('TTW Translation Connector could not store an event for post ' . (int) $post_id);
        return 'failed';
    }
    return $inserted === 1 ? 'queued' : 'unchanged';
}

add_action('wp_after_insert_post', function ($post_id, $post, $update, $before) {
    if (!in_array($post->post_type, array('post', 'page'), true) || wp_is_post_revision($post_id) || wp_is_post_autosave($post_id)) { return; }
    if ($post->post_type === 'page' && $post->post_status === 'publish') {
        if ($post->post_password !== '') {
            ttw_translation_withdraw($post);
            return;
        }
        if (ttw_translation_settings()['updates'] && ttw_translation_latest_event($post_id)) {
            ttw_translation_enqueue($post, 'publish', 'page');
        }
        return;
    }
    if ($post->post_status === 'publish' && ttw_translation_mode($post_id) === 'automatic') {
        $settings = ttw_translation_settings();
        $already_published = $update && $before && $before->post_status === 'publish';
        if (!$already_published || $settings['updates']) {
            ttw_translation_enqueue($post, 'publish', 'automatic');
        }
    } elseif ($post->post_status !== 'publish' && $update && $before && $before->post_status === 'publish') {
        ttw_translation_withdraw($post);
    }
}, 20, 4);

add_action('wp_restore_post_revision', function ($post_id) {
    $post = get_post($post_id);
    if ($post && $post->post_type === 'post' && $post->post_status === 'publish'
        && ttw_translation_settings()['revision_saves'] && ttw_translation_mode($post_id) === 'automatic') {
        ttw_translation_enqueue($post, 'publish', 'automatic');
    }
});

add_action('before_delete_post', function ($post_id, $post) {
    if (in_array($post->post_type, array('post', 'page'), true) && $post->post_status === 'publish') {
        ttw_translation_withdraw($post);
    }
}, 10, 2);

add_action('ttw_translation_sync_pages', function ($user_id, $cursor) {
    if (!user_can($user_id, 'manage_options')) { return; }
    global $wpdb;
    $ids = $wpdb->get_col($wpdb->prepare(
        "SELECT ID FROM {$wpdb->posts} WHERE post_type='page' AND post_status='publish' AND post_password=''
        AND ID>%d ORDER BY ID LIMIT 25", $cursor
    ));
    foreach ($ids as $id) {
        $post = get_post((int) $id);
        if ($post && $post->post_status === 'publish' && $post->post_password === '' && user_can($user_id, 'edit_post', $post->ID)) {
            ttw_translation_enqueue($post, 'publish', 'page', true);
        }
    }
    if (count($ids) === 25) {
        wp_schedule_single_event(time() + 10, 'ttw_translation_sync_pages', array($user_id, (int) end($ids)));
    }
}, 10, 2);

function ttw_translation_withdraw($post) {
    $prior = ttw_translation_latest_event($post->ID);
    if ($prior || get_post_meta($post->ID, '_ttw_translation_central_id', true)) {
        ttw_translation_enqueue($post, 'withdrawn', 'lifecycle');
    }
}

add_action('ttw_translation_outbox_run', function () {
    list($endpoint, $key, $secret) = ttw_translation_connection();
    if (!$key || !$secret || !wp_parse_url($endpoint, PHP_URL_HOST)) { return; }
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
        $response = ttw_translation_request($event->payload, $event->request_id);
        $code = is_wp_error($response) ? 0 : (int) wp_remote_retrieve_response_code($response);
        $body = is_wp_error($response) ? null : json_decode(wp_remote_retrieve_body($response), true);
        $where = array('id' => $event->id, 'state' => 'sending', 'run_at' => $lease);
        $attempts = (int) $event->attempts + 1;
        $article_id = is_array($body) ? absint($body['articleId'] ?? 0) : 0;
        if ($code >= 200 && $code < 300 && $article_id) {
            $saved_hash = $event->payload_hash;
            if (!$saved_hash) {
                $previous = json_decode($event->payload, true);
                if (is_array($previous)) { $saved_hash = ttw_translation_fingerprint($previous); }
            }
            $recorded = $wpdb->update($table, array(
                'state' => 'sent', 'attempts' => $attempts, 'last_code' => $code, 'delivered_at' => time(),
                'article_id' => $article_id, 'response_note' => 'Accepted by central app',
                'payload_hash' => $saved_hash, 'payload' => $saved_hash ? '' : $event->payload,
            ), $where);
            if ($recorded && get_post($event->post_id)) {
                update_post_meta($event->post_id, '_ttw_translation_central_id', $article_id);
            }
            continue;
        }
        $retry = $attempts < 12 && ($code < 200 || $code === 429 || $code >= 500);
        $allowed_fields = array_keys(ttw_translation_payload_defaults());
        $fields = is_array($body) && isset($body['message']) && is_array($body['message'])
            ? array_intersect($allowed_fields, array_filter($body['message'], 'is_string')) : array();
        $note = $fields ? 'Rejected fields: ' . implode(', ', $fields) : ($code ? 'Unexpected HTTP response' : 'Could not reach central app');
        $wpdb->update($table, array(
            'state' => $retry ? 'pending' : 'failed', 'attempts' => $attempts,
            'run_at' => time() + min(21600, 60 * (2 ** min($attempts - 1, 9))), 'last_code' => $code, 'response_note' => $note,
        ), $where);
    }
});

function ttw_translation_payload_defaults() {
    return array_fill_keys(array('postId','sourceHost','title','content','excerpt','featuredImage','imageAlt','author',
        'categories','tags','slug','publishedAt','modifiedAt','status','canonical','seoTitle','seoDescription',
        'language','articleType','siteId','categoryIds','imageMetadata'), '');
}

if (is_admin()) { require_once __DIR__ . '/admin.php'; }
