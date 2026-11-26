<?php
if (!defined('ABSPATH')) { exit; }

function ttw_translation_admin_url($page = 'ttw-translation', $args = array()) {
    return add_query_arg(array_merge(array('page' => $page), $args), admin_url('admin.php'));
}

function ttw_translation_admin_guard($nonce) {
    if (!current_user_can('manage_options')) { wp_die('Permission denied', '', 403); }
    check_admin_referer($nonce);
}

function ttw_translation_admin_redirect($page, $args = array()) {
    wp_safe_redirect(ttw_translation_admin_url($page, $args));
    exit;
}

function ttw_translation_post_form($action, $button) {
    echo '<form style="display:inline-block;margin-right:.5rem" method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
    echo '<input type="hidden" name="action" value="' . esc_attr($action) . '">';
    wp_nonce_field($action);
    submit_button($button, 'secondary', 'submit', false);
    echo '</form>';
}

function ttw_translation_begin($title) {
    if (!current_user_can('manage_options')) { wp_die('Permission denied', '', 403); }
    echo '<div class="wrap"><h1>' . esc_html($title) . '</h1>';
    $notice = isset($_GET['ttw_notice']) ? sanitize_key(wp_unslash($_GET['ttw_notice'])) : '';
    $messages = array(
        'settings' => 'Settings saved.', 'rules' => 'Category rules saved.',
        'retry' => 'Failed deliveries returned to the queue.',
        'invalid_url' => 'Enter the central app URL using HTTPS. Use the site root or include /api.',
        'invalid_site' => 'The site ID may only contain letters, numbers, underscores, or hyphens.',
        'categories_synced' => sprintf('%d categories synced.', absint($_GET['synced'] ?? 0)),
        'invalid_category_sync' => 'Category sync failed. Test the saved connection and verify the central app is up to date.',
        'pages_synced' => 'Published pages are being queued for translation. Check Logs and the central Translation Jobs screen.',
        'invalid_page_sync' => 'WordPress could not schedule the page sync.',
        'manual' => sprintf('%d queued, %d unchanged, %d skipped.',
            absint($_GET['queued'] ?? 0), absint($_GET['unchanged'] ?? 0), absint($_GET['skipped'] ?? 0)),
    );
    if (isset($messages[$notice])) {
        $kind = strpos($notice, 'invalid_') === 0 ? 'error' : 'success';
        echo '<div class="notice notice-' . esc_attr($kind) . '"><p>' . esc_html($messages[$notice]) . '</p></div>';
    }
}

add_action('admin_menu', function () {
    $root = 'ttw-translation';
    add_menu_page('Translation Platform', 'Translation Platform', 'manage_options', $root, 'ttw_translation_dashboard', 'dashicons-translation');
    add_submenu_page($root, 'Dashboard', 'Dashboard', 'manage_options', $root, 'ttw_translation_dashboard');
    add_submenu_page($root, 'Articles', 'Articles', 'manage_options', 'ttw-translation-articles', 'ttw_translation_articles');
    add_submenu_page($root, 'Website pages', 'Website pages', 'manage_options', 'ttw-translation-pages', 'ttw_translation_pages');
    add_submenu_page($root, 'Settings', 'Settings', 'manage_options', 'ttw-translation-settings', 'ttw_translation_settings_page');
    add_submenu_page($root, 'Sent Articles', 'Sent Articles', 'manage_options', 'ttw-translation-sent', function () { ttw_translation_logs(true); });
    add_submenu_page($root, 'Logs', 'Logs', 'manage_options', 'ttw-translation-logs', function () { ttw_translation_logs(false); });
    add_management_page('Translation Connector', 'Translation Connector', 'manage_options', $root, function () { ttw_translation_logs(false); });
});

function ttw_translation_pages() {
    ttw_translation_begin('Website pages');
    echo '<p>Send published pages to each enabled language edition. Each translation follows that edition’s approval setting.</p>';
    ttw_translation_post_form('ttw_translation_sync_pages', 'Translate all published pages');
    echo '<p><a href="' . esc_url(admin_url('edit.php?post_type=page')) . '">Choose individual pages from the WordPress Pages list</a></p></div>';
}

add_action('admin_post_ttw_translation_sync_pages', function () {
    ttw_translation_admin_guard('ttw_translation_sync_pages');
    $args = array(get_current_user_id(), 0);
    $scheduled = wp_next_scheduled('ttw_translation_sync_pages', $args)
        || wp_schedule_single_event(time() + 5, 'ttw_translation_sync_pages', $args);
    ttw_translation_admin_redirect('ttw-translation-pages', array('ttw_notice' => $scheduled ? 'pages_synced' : 'invalid_page_sync'));
});

add_filter('bulk_actions-edit-page', function ($actions) {
    if (current_user_can('manage_options')) { $actions['ttw_translate_pages'] = 'Send pages to Translation Platform'; }
    return $actions;
});
add_filter('handle_bulk_actions-edit-page', function ($redirect, $action, $ids) {
    if (!current_user_can('manage_options') || $action !== 'ttw_translate_pages') { return $redirect; }
    $counts = array('queued' => 0, 'unchanged' => 0, 'skipped' => 0);
    foreach (array_unique(array_map('absint', $ids)) as $id) {
        $post = get_post($id);
        if (!$post || $post->post_type !== 'page' || $post->post_status !== 'publish' || $post->post_password !== '' || !current_user_can('edit_post', $id)) {
            ++$counts['skipped'];
            continue;
        }
        $result = ttw_translation_enqueue($post, 'publish', 'page', true);
        ++$counts[$result === 'failed' ? 'skipped' : $result];
    }
    return ttw_translation_admin_url('ttw-translation-pages', array_merge($counts, array('ttw_notice' => 'manual')));
}, 10, 3);

function ttw_translation_dashboard() {
    global $wpdb;
    $table = ttw_translation_table();
    $since = current_datetime()->setTime(0, 0)->getTimestamp();
    $totals = $wpdb->get_row($wpdb->prepare(
        "SELECT COUNT(DISTINCT CASE WHEN delivery_mode='automatic' AND state='sent' AND delivered_at >= %d THEN post_id END) automatic,
        COUNT(DISTINCT CASE WHEN state='sent' THEN post_id END) sent,
        SUM(state='failed') failed, MAX(delivered_at) last_success FROM $table", $since
    ));
    $today = array('after' => wp_date('Y-m-d', $since), 'inclusive' => true);
    $counts = array('post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 1, 'fields' => 'ids', 'date_query' => array($today));
    $published = new WP_Query($counts);
    $manual_taxonomy = ttw_translation_manual_taxonomy();
    $manual = $manual_taxonomy ? new WP_Query(array_merge($counts, array(
        'tax_query' => $manual_taxonomy,
        'where_ttw_manual_waiting' => true,
    ))) : null;
    $connection = get_option('ttw_translation_connection_status', array());
    ttw_translation_begin('Translation Platform');
    echo '<table class="widefat striped" style="max-width:760px"><tbody>';
    foreach (array(
        'Connection' => $connection['message'] ?? 'Connection test pending',
        'Published today' => $published->found_posts,
        'Automatically sent today' => (int) $totals->automatic,
        'Waiting for manual selection today' => $manual ? $manual->found_posts : 0,
        'Articles accepted' => (int) $totals->sent,
        'Failed deliveries' => (int) $totals->failed,
        'Last successful sync' => $totals->last_success ? wp_date('Y-m-d H:i:s T', (int) $totals->last_success) : '—',
    ) as $label => $value) {
        echo '<tr><th scope="row">' . esc_html($label) . '</th><td>' . esc_html($value) . '</td></tr>';
    }
    echo '</tbody></table><p>';
    foreach (array('articles' => 'Select articles', 'sent' => 'View sent articles', 'settings' => 'Configure categories') as $page => $label) {
        echo '<a class="button" style="margin-right:.5rem" href="' . esc_url(ttw_translation_admin_url('ttw-translation-' . $page)) . '">' . esc_html($label) . '</a>';
    }
    echo '</p>';
    ttw_translation_post_form('ttw_translation_test', 'Test connection');
    ttw_translation_post_form('ttw_translation_sync_categories', 'Sync categories');
    ttw_translation_post_form('ttw_translation_retry_all', 'Retry failed deliveries');
    echo '</div>';
}

function ttw_translation_settings_page() {
    $values = ttw_translation_settings();
    $status = get_option('ttw_translation_connection_status', array());
    ttw_translation_begin('Translation Platform Settings');
    echo '<h2>Connection</h2><p>' . esc_html($status['message'] ?? 'Connection test pending') . '</p>';
    echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
    echo '<input type="hidden" name="action" value="ttw_translation_save_settings">';
    wp_nonce_field('ttw_translation_save_settings');
    echo '<table class="form-table"><tbody>';
    foreach (array(
        'url' => array('Central application URL', 'TTW_TRANSLATION_ENDPOINT', 'url'),
        'key' => array('Webhook API key', 'TTW_TRANSLATION_API_KEY', 'password'),
        'secret' => array('Webhook secret', 'TTW_TRANSLATION_SECRET', 'password'),
        'site_id' => array('Site ID', '', 'text'),
    ) as $name => $field) {
        list($label, $constant, $type) = $field;
        echo '<tr><th><label for="ttw-field-' . esc_attr($name) . '">' . esc_html($label) . '</label></th><td>';
        if ($constant && defined($constant)) {
            echo '<span>Configured in wp-config.php</span>';
        } else {
            $value = $type === 'password' ? '' : $values[$name];
            $placeholder = $type === 'password' && $values[$name] !== '' ? 'Saved. Enter a replacement to update.' : '';
            echo '<input id="ttw-field-' . esc_attr($name) . '" class="regular-text" type="' . esc_attr($type) .
                '" autocomplete="off" name="' . esc_attr($name) . '" value="' . esc_attr($value) . '" placeholder="' . esc_attr($placeholder) . '">';
        }
        echo '</td></tr>';
    }
    echo '<tr><th scope="row">Sending and payload</th><td>';
    foreach (ttw_translation_settings_checks() as $name => $label) {
        echo '<label><input type="checkbox" name="' . esc_attr($name) . '" value="1" ' . checked(!empty($values[$name]), true, false) .
            '> ' . esc_html($label) . '</label><br>';
    }
    echo '</td></tr></tbody></table>';
    submit_button('Save connection and sending settings');
    echo '</form>';
    ttw_translation_post_form('ttw_translation_test', 'Test saved connection');
    ttw_translation_category_settings();
    echo '</div>';
}

function ttw_translation_settings_checks() {
    return array(
        'updates' => 'Send updates to published posts in Automatic categories',
        'revision_saves' => 'Send restored published revisions even when automatic updates are off',
        'unchanged' => 'Allow unchanged articles to be sent again',
        'excerpt' => 'Include excerpt', 'image' => 'Include featured image, dimensions, and alt text',
        'seo' => 'Include SEO fields', 'tags' => 'Include tags', 'author' => 'Include author',
        'category' => 'Include category names and IDs for central distribution',
    );
}

add_action('admin_post_ttw_translation_save_settings', function () {
    ttw_translation_admin_guard('ttw_translation_save_settings');
    $values = ttw_translation_settings();
    if (isset($_POST['url']) && !defined('TTW_TRANSLATION_ENDPOINT')) {
        $value = trim(wp_unslash($_POST['url']));
        $parsed = wp_parse_url($value);
        $allowed = wp_get_environment_type() === 'local' ? array('http', 'https') : array('https');
        if ($value && (empty($parsed['host']) || !in_array($parsed['scheme'] ?? '', $allowed, true)
            || isset($parsed['user']) || isset($parsed['pass']) || isset($parsed['query']) || isset($parsed['fragment'])
            || !in_array(rtrim($parsed['path'] ?? '', '/'), array('', '/api', '/api/v1/webhooks/wordpress/article'), true))) {
            ttw_translation_admin_redirect('ttw-translation-settings', array('ttw_notice' => 'invalid_url'));
        }
        $values['url'] = preg_replace('~/api(?:/v1/webhooks/wordpress/article)?$~', '', rtrim(esc_url_raw($value, $allowed), '/'));
    }
    $site = isset($_POST['site_id']) ? trim(wp_unslash($_POST['site_id'])) : '';
    if ($site && !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $site)) {
        ttw_translation_admin_redirect('ttw-translation-settings', array('ttw_notice' => 'invalid_site'));
    }
    $values['site_id'] = $site;
    foreach (array('key' => 'TTW_TRANSLATION_API_KEY', 'secret' => 'TTW_TRANSLATION_SECRET') as $name => $constant) {
        if (!defined($constant) && isset($_POST[$name])) {
            $value = trim(wp_unslash($_POST[$name]));
            if (preg_match('/^[!-~]{1,512}$/D', $value)) { $values[$name] = $value; }
        }
    }
    foreach (ttw_translation_settings_checks() as $name => $label) {
        $values[$name] = !empty($_POST[$name]);
    }
    update_option('ttw_translation_settings', $values, false);
    delete_option('ttw_translation_connection_status');
    ttw_translation_admin_redirect('ttw-translation-settings', array('ttw_notice' => 'settings'));
});

add_action('admin_post_ttw_translation_test', function () {
    ttw_translation_admin_guard('ttw_translation_test');
    $settings = ttw_translation_settings();
    $request = array('sourceHost' => wp_parse_url(home_url(), PHP_URL_HOST));
    if ($settings['site_id'] !== '') { $request['siteId'] = $settings['site_id']; }
    $result = ttw_translation_request(wp_json_encode($request), wp_generate_uuid4(), 'test');
    $code = is_wp_error($result) ? 0 : (int) wp_remote_retrieve_response_code($result);
    $payload = is_wp_error($result) ? null : json_decode(wp_remote_retrieve_body($result), true);
    $ok = $code === 200 && is_array($payload) && ($payload['status'] ?? '') === 'connected';
    $message = $ok ? 'Connected' : ($code ? 'Disconnected (HTTP ' . $code . ')' : 'Disconnected (check URL and credentials)');
    update_option('ttw_translation_connection_status', array('message' => $message, 'checked_at' => time()), false);
    ttw_translation_admin_redirect('ttw-translation-settings');
});

add_action('admin_post_ttw_translation_sync_categories', function () {
    ttw_translation_admin_guard('ttw_translation_sync_categories');
    $terms = get_terms(array('taxonomy' => 'category', 'hide_empty' => false, 'number' => 5001));
    if (is_wp_error($terms) || count($terms) > 5000) {
        ttw_translation_admin_redirect('ttw-translation', array('ttw_notice' => 'invalid_category_sync'));
    }
    $settings = ttw_translation_settings();
    $payload = array(
        'sourceHost' => wp_parse_url(home_url(), PHP_URL_HOST),
        'categories' => array_map(function ($term) {
            return array('id' => (int) $term->term_id, 'parent' => (int) $term->parent, 'name' => $term->name);
        }, $terms),
    );
    if ($settings['site_id'] !== '') { $payload['siteId'] = $settings['site_id']; }
    $response = ttw_translation_request(wp_json_encode($payload), wp_generate_uuid4(), 'categories');
    $code = is_wp_error($response) ? 0 : (int) wp_remote_retrieve_response_code($response);
    $data = !is_wp_error($response) ? json_decode(wp_remote_retrieve_body($response), true) : null;
    ttw_translation_admin_redirect('ttw-translation', $code === 200 && isset($data['synced'])
        ? array('ttw_notice' => 'categories_synced', 'synced' => absint($data['synced']))
        : array('ttw_notice' => 'invalid_category_sync'));
});

function ttw_translation_category_settings() {
    $filter = sanitize_text_field(wp_unslash($_GET['category_search'] ?? ''));
    $page = max(1, min(10000, absint($_GET['category_page'] ?? 1)));
    $terms = get_terms(array('taxonomy' => 'category', 'hide_empty' => false,
        'number' => 51, 'offset' => ($page - 1) * 50, 'search' => $filter,
    ));
    $rules = ttw_translation_rules();
    echo '<hr><h2>Category rules</h2><p>Unconfigured posts are held. A child can inherit its nearest applicable parent rule. For posts in several categories, Disabled takes priority, followed by Manual and Automatic.</p>';
    echo '<form method="get"><input type="hidden" name="page" value="ttw-translation-settings"><label>Find category <input type="search" name="category_search" value="' .
        esc_attr($filter) . '"></label> <button class="button">Search</button></form>';
    if (is_wp_error($terms) || !$terms) { echo '<p>No categories found.</p>'; return; }
    echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '"><input type="hidden" name="action" value="ttw_translation_save_rules">';
    wp_nonce_field('ttw_translation_save_rules');
    echo '<input type="hidden" name="category_page" value="' . esc_attr($page) . '"><input type="hidden" name="category_search" value="' . esc_attr($filter) . '">';
    echo '<table class="widefat striped"><thead><tr><th>Category</th><th>Mode</th><th>Apply to child categories</th></tr></thead><tbody>';
    foreach (array_slice($terms, 0, 50) as $term) {
        $id = (int) $term->term_id;
        $rule = $rules[$id] ?? array();
        $parent = $term->parent ? get_term($term->parent, 'category') : null;
        echo '<tr><td><label for="ttw-rule-' . esc_attr($id) . '">' . esc_html($term->name) . '</label>';
        if ($parent instanceof WP_Term) { echo ' <small>↳ ' . esc_html($parent->name) . '</small>'; }
        echo '</td><td><select id="ttw-rule-' . esc_attr($id) . '" name="mode[' . esc_attr($id) . ']">';
        foreach (array('inherit' => 'Inherit / unconfigured', 'manual' => 'Manual', 'automatic' => 'Automatic', 'disabled' => 'Disabled') as $mode => $label) {
            echo '<option value="' . esc_attr($mode) . '" ' . selected($rule['mode'] ?? 'inherit', $mode, false) . '>' . esc_html($label) . '</option>';
        }
        echo '</select></td><td><input type="checkbox" aria-label="' . esc_attr('Include child categories of ' . $term->name) . '" name="children[' .
            esc_attr($id) . ']" value="1" ' . checked(!empty($rule['children']), true, false) . '></td></tr>';
    }
    echo '</tbody></table>';
    submit_button('Save category rules');
    echo '</form>';
    foreach (array($page > 1 ? $page - 1 : 0 => 'Previous', count($terms) > 50 ? $page + 1 : 0 => 'Next') as $number => $label) {
        if ($number) {
            echo '<a class="button" href="' . esc_url(ttw_translation_admin_url('ttw-translation-settings', array(
                'category_page' => $number, 'category_search' => $filter,
            ))) . '">' . esc_html($label) . '</a> ';
        }
    }
}

add_action('admin_post_ttw_translation_save_rules', function () {
    ttw_translation_admin_guard('ttw_translation_save_rules');
    $rules = ttw_translation_rules();
    foreach (array_slice((array) ($_POST['mode'] ?? array()), 0, 50, true) as $id => $mode) {
        $id = absint($id);
        if (!term_exists($id, 'category')) { continue; }
        if (in_array($mode, array('manual', 'automatic', 'disabled'), true)) {
            $rules[$id] = array('mode' => $mode, 'children' => !empty($_POST['children'][$id]));
        } elseif ($mode === 'inherit') {
            unset($rules[$id]);
        }
    }
    update_option('ttw_translation_category_rules', $rules, false);
    ttw_translation_admin_redirect('ttw-translation-settings', array(
        'ttw_notice' => 'rules', 'category_page' => absint($_POST['category_page'] ?? 1),
        'category_search' => sanitize_text_field(wp_unslash($_POST['category_search'] ?? '')),
    ));
});

function ttw_translation_manual_taxonomy() {
    $terms = get_terms(array('taxonomy' => 'category', 'hide_empty' => false));
    if (is_wp_error($terms)) { return array(); }
    $modes = array('manual' => array(), 'disabled' => array());
    $rules = ttw_translation_rules();
    $by_id = array();
    foreach ($terms as $term) { $by_id[$term->term_id] = $term; }
    foreach ($terms as $term) {
        $rule = $rules[$term->term_id] ?? null;
        $ancestor = (int) $term->parent;
        while (!$rule && $ancestor && isset($by_id[$ancestor])) {
            if (!empty($rules[$ancestor]['children'])) { $rule = $rules[$ancestor]; }
            $ancestor = (int) $by_id[$ancestor]->parent;
        }
        $mode = $rule['mode'] ?? '';
        if (isset($modes[$mode])) { $modes[$mode][] = (int) $term->term_id; }
    }
    if (!$modes['manual']) { return array(); }
    $filters = array(array('taxonomy' => 'category', 'terms' => $modes['manual'], 'include_children' => false));
    if ($modes['disabled']) { $filters[] = array('taxonomy' => 'category', 'terms' => $modes['disabled'], 'operator' => 'NOT IN', 'include_children' => false); }
    return $filters;
}

add_filter('posts_where', function ($where, $query) {
    if (!$query->get('where_ttw_manual_waiting')) { return $where; }
    global $wpdb;
    $table = ttw_translation_table();
    return $where . " AND NOT EXISTS (SELECT 1 FROM $table WHERE post_id={$wpdb->posts}.ID AND state IN ('sent','pending','sending'))";
}, 10, 2);

function ttw_translation_articles() {
    $search = sanitize_text_field(wp_unslash($_GET['s'] ?? ''));
    $category = absint($_GET['cat'] ?? 0);
    $date = sanitize_text_field(wp_unslash($_GET['month'] ?? ''));
    $page = max(1, absint($_GET['paged'] ?? 1));
    $taxonomy = ttw_translation_manual_taxonomy();
    if ($taxonomy && $category) {
        $taxonomy[] = array('taxonomy' => 'category', 'terms' => array($category), 'include_children' => true);
    }
    $query = $taxonomy ? new WP_Query(array(
        'post_type' => 'post', 'post_status' => 'publish', 'posts_per_page' => 30, 'tax_query' => $taxonomy,
        's' => $search, 'm' => preg_match('/^\d{4}-\d{2}$/D', $date) ? str_replace('-', '', $date) : '',
        'paged' => $page,
    )) : null;
    ttw_translation_begin('Select articles for translation');
    echo '<form method="get"><input type="hidden" name="page" value="ttw-translation-articles">';
    echo '<label>Search <input type="search" name="s" value="' . esc_attr($search) . '"></label> ';
    wp_dropdown_categories(array('show_option_all' => 'All categories', 'name' => 'cat', 'selected' => $category, 'hierarchical' => true));
    echo ' <label>Month <input type="month" name="month" value="' . esc_attr($date) . '"></label> <button class="button">Filter</button></form>';
    if (!$query || !$query->posts) { echo '<p>No published articles match the Manual category rules and filters.</p></div>'; return; }
    echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '"><input type="hidden" name="action" value="ttw_translation_send">';
    wp_nonce_field('ttw_translation_send');
    echo '<table class="wp-list-table widefat striped" style="margin-top:1rem"><thead><tr><td class="manage-column column-cb check-column"><input id="cb-select-all-1" type="checkbox" aria-label="Select all visible"></td><th>Title</th><th>Categories</th><th>Date</th><th>Translation Platform</th></tr></thead><tbody>';
    foreach ($query->posts as $post) {
        $post_id = (int) $post->ID;
        $terms = get_the_category($post_id);
        echo '<tr><th scope="row" class="check-column"><input type="checkbox" name="post_ids[]" value="' . esc_attr($post_id) . '" aria-label="Select article ' . esc_attr($post_id) . '"></th>';
        echo '<td><a href="' . esc_url(get_edit_post_link($post_id)) . '">' . esc_html($post->post_title ?: '(Untitled)') . '</a></td>';
        echo '<td>' . esc_html(implode(', ', wp_list_pluck($terms, 'name'))) . '</td><td>' . esc_html(get_the_date('', $post_id)) .
            '</td><td>' . esc_html(ttw_translation_status($post_id)) . '</td></tr>';
    }
    echo '</tbody></table><p><button class="button button-primary" name="operation" value="send">Send selected articles</button> ';
    echo '<button class="button" name="operation" value="resend">Resend selected articles</button></p></form>';
    echo wp_kses_post(paginate_links(array('total' => $query->max_num_pages, 'current' => $page, 'type' => 'list')));
    echo '</div>';
}

function ttw_translation_status($id) {
    global $wpdb;
    $table = ttw_translation_table();
    $state = $wpdb->get_var($wpdb->prepare("SELECT state FROM $table WHERE post_id=%d ORDER BY id DESC LIMIT 1", $id));
    $labels = array('sent' => 'Sent', 'pending' => 'Queued', 'sending' => 'Sending', 'failed' => 'Failed');
    return $labels[$state] ?? 'Not sent';
}

function ttw_translation_manual_send($ids, $resend) {
    $counts = array('queued' => 0, 'unchanged' => 0, 'skipped' => 0);
    foreach (array_slice(array_unique(array_map('absint', $ids)), 0, 100) as $id) {
        $post = get_post($id);
        $mode = $post ? ttw_translation_mode($id) : 'disabled';
        if (!$post || $post->post_type !== 'post' || $post->post_status !== 'publish' || !current_user_can('edit_post', $id)
            || ($mode !== 'manual' && !($mode === 'automatic' && $resend && ttw_translation_latest_event($id)))) {
            ++$counts['skipped'];
            continue;
        }
        $result = ttw_translation_enqueue($post, 'publish', 'manual', $resend);
        ++$counts[$result === 'failed' ? 'skipped' : $result];
    }
    return $counts;
}

add_action('admin_post_ttw_translation_send', function () {
    ttw_translation_admin_guard('ttw_translation_send');
    $counts = ttw_translation_manual_send((array) ($_POST['post_ids'] ?? array()), ($_POST['operation'] ?? '') === 'resend');
    ttw_translation_admin_redirect('ttw-translation-articles', array_merge($counts, array('ttw_notice' => 'manual')));
});

add_filter('manage_post_posts_columns', function ($columns) {
    if (current_user_can('manage_options')) { $columns['ttw_translation'] = 'Translation Platform'; }
    return $columns;
});
add_action('manage_post_posts_custom_column', function ($column, $id) {
    if ($column === 'ttw_translation' && current_user_can('manage_options')) { echo esc_html(ttw_translation_status($id)); }
}, 10, 2);
add_filter('bulk_actions-edit-post', function ($actions) {
    if (current_user_can('manage_options')) {
        $actions['ttw_send'] = 'Send to Translation Platform';
        $actions['ttw_resend'] = 'Resend to Translation Platform';
    }
    return $actions;
});
add_filter('handle_bulk_actions-edit-post', function ($redirect, $action, $ids) {
    if (!current_user_can('manage_options') || !in_array($action, array('ttw_send', 'ttw_resend'), true)) { return $redirect; }
    return ttw_translation_admin_url('ttw-translation-articles',
        array_merge(ttw_translation_manual_send($ids, $action === 'ttw_resend'), array('ttw_notice' => 'manual')));
}, 10, 3);

function ttw_translation_logs($sent) {
    global $wpdb;
    $table = ttw_translation_table();
    $page = max(1, min(10000, absint($_GET['paged'] ?? 1)));
    $filter = $sent ? " WHERE state='sent'" : '';
    $records = $wpdb->get_results($wpdb->prepare(
        "SELECT id,request_id,post_id,state,attempts,last_code,article_id,created_at,response_note FROM $table" .
        $filter . " ORDER BY id DESC LIMIT 51 OFFSET %d", ($page - 1) * 50
    ));
    ttw_translation_begin($sent ? 'Sent Articles' : 'Translation Connector Logs');
    if (!$sent) { ttw_translation_post_form('ttw_translation_retry_all', 'Retry failed deliveries'); }
    echo '<table class="widefat striped" style="margin-top:1rem"><thead><tr><th>Request ID</th><th>Post</th><th>Queued at</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Central article</th><th>Response</th><th>Action</th></tr></thead><tbody>';
    foreach (array_slice($records, 0, 50) as $record) {
        echo '<tr><td>' . esc_html($record->request_id) . '</td><td>' . esc_html($record->post_id) . '</td>';
        echo '<td>' . esc_html($record->created_at ? wp_date('Y-m-d H:i', (int) $record->created_at) : '—') . '</td>';
        echo '<td>' . esc_html($record->state) . '</td><td>' . esc_html($record->attempts) . '</td><td>' .
            esc_html($record->last_code ?: '—') . '</td><td>' . esc_html($record->article_id ?: '—') . '</td><td>' .
            esc_html($record->response_note) . '</td><td>';
        if ($record->state === 'failed') {
            $url = wp_nonce_url(add_query_arg(array('action' => 'ttw_translation_resend', 'id' => $record->id), admin_url('admin-post.php')), 'ttw_translation_resend_' . $record->id);
            echo '<a href="' . esc_url($url) . '">Retry delivery</a>';
        }
        echo '</td></tr>';
    }
    if (!$records) { echo '<tr><td colspan="9">No deliveries to show.</td></tr>'; }
    echo '</tbody></table><p>';
    $slug = $sent ? 'ttw-translation-sent' : 'ttw-translation-logs';
    if ($page > 1) { echo '<a class="button" href="' . esc_url(ttw_translation_admin_url($slug, array('paged' => $page - 1))) . '">Previous</a> '; }
    if (count($records) > 50) { echo '<a class="button" href="' . esc_url(ttw_translation_admin_url($slug, array('paged' => $page + 1))) . '">Next</a>'; }
    echo '</p></div>';
}

add_action('admin_post_ttw_translation_resend', function () {
    $id = absint($_GET['id'] ?? 0);
    ttw_translation_admin_guard('ttw_translation_resend_' . $id);
    global $wpdb;
    $wpdb->update(ttw_translation_table(), array('attempts' => 0, 'state' => 'pending', 'run_at' => time()),
        array('id' => $id, 'state' => 'failed'));
    ttw_translation_admin_redirect('ttw-translation-logs', array('ttw_notice' => 'retry'));
});

add_action('admin_post_ttw_translation_retry_all', function () {
    ttw_translation_admin_guard('ttw_translation_retry_all');
    global $wpdb;
    $table = ttw_translation_table();
    $wpdb->query($wpdb->prepare("UPDATE $table SET attempts=0,state='pending',run_at=%d WHERE state='failed'", time()));
    ttw_translation_admin_redirect('ttw-translation-logs', array('ttw_notice' => 'retry'));
});
