CREATE TABLE IF NOT EXISTS website_settings (
  id TINYINT UNSIGNED PRIMARY KEY,
  published_version INT UNSIGNED
);
INSERT IGNORE INTO website_settings (id) VALUES (1);
CREATE TABLE IF NOT EXISTS website_versions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  configuration JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS website_domain_overrides (
  domain_id INT UNSIGNED PRIMARY KEY,
  configuration JSON NOT NULL,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS static_translations (
  language_id INT UNSIGNED PRIMARY KEY,
  translations JSON NOT NULL,
  FOREIGN KEY (language_id) REFERENCES languages(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS public_cache_generations (
  domain_id INT UNSIGNED PRIMARY KEY,
  generation BIGINT UNSIGNED NOT NULL
);
CREATE TABLE IF NOT EXISTS domain_routing (
  domain_id INT UNSIGNED PRIMARY KEY,
  provider_id INT UNSIGNED,
  fallback_provider_id INT UNSIGNED,
  priority SMALLINT UNSIGNED,
  FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id),
  FOREIGN KEY (fallback_provider_id) REFERENCES translation_providers(id)
);
CREATE TABLE IF NOT EXISTS provider_policies (
  provider_id INT UNSIGNED PRIMARY KEY,
  requests_per_minute INT UNSIGNED,
  requests_per_day INT UNSIGNED,
  concurrent_requests SMALLINT UNSIGNED,
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS admin_activity (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  method VARCHAR(8) NOT NULL,
  path VARCHAR(255) NOT NULL,
  status SMALLINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS distribution_rules (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  category VARCHAR(200) NOT NULL,
  group_id INT UNSIGNED,
  domain_id INT UNSIGNED,
  daily_limit INT UNSIGNED NOT NULL,
  priority SMALLINT UNSIGNED NOT NULL,
  provider_id INT UNSIGNED,
  fallback_provider_id INT UNSIGNED,
  enabled BOOLEAN NOT NULL,
  INDEX (category,enabled,priority),
  FOREIGN KEY (group_id) REFERENCES translation_groups(id),
  FOREIGN KEY (domain_id) REFERENCES domains(id),
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id),
  FOREIGN KEY (fallback_provider_id) REFERENCES translation_providers(id)
);
CREATE TABLE IF NOT EXISTS wordpress_categories (
  source_host VARCHAR(253) NOT NULL,
  source_term_id BIGINT UNSIGNED NOT NULL,
  parent_term_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  PRIMARY KEY (source_host,source_term_id)
);
CREATE TABLE IF NOT EXISTS distribution_allocations (
  rule_id INT UNSIGNED NOT NULL,
  utc_day DATE NOT NULL,
  used INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (rule_id,utc_day),
  FOREIGN KEY (rule_id) REFERENCES distribution_rules(id)
);
CREATE TABLE IF NOT EXISTS distributed_articles (
  rule_id INT UNSIGNED NOT NULL,
  utc_day DATE NOT NULL,
  article_id INT UNSIGNED NOT NULL,
  PRIMARY KEY (rule_id,utc_day,article_id),
  FOREIGN KEY (rule_id,utc_day) REFERENCES distribution_allocations(rule_id,utc_day),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
