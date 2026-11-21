CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('super_admin','admin','editor','translation_manager','technical') NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS languages (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL UNIQUE,
  name VARCHAR(80) NOT NULL
);
CREATE TABLE IF NOT EXISTS translation_providers (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  adapter ENUM('deepl','mock') NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cost_inr_per_million DECIMAL(14,4) NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS translation_groups (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(500) NOT NULL DEFAULT '',
  daily_limit INT UNSIGNED NOT NULL,
  priority SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  provider_id INT UNSIGNED NOT NULL,
  fallback_provider_id INT UNSIGNED,
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id),
  FOREIGN KEY (fallback_provider_id) REFERENCES translation_providers(id)
);
CREATE TABLE IF NOT EXISTS domains (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  hostname VARCHAR(253) NOT NULL UNIQUE,
  origin VARCHAR(350) NOT NULL,
  language_id INT UNSIGNED NOT NULL,
  group_id INT UNSIGNED NOT NULL,
  daily_limit INT UNSIGNED,
  timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sitemap_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rss_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  manual_approval BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (language_id) REFERENCES languages(id),
  FOREIGN KEY (group_id) REFERENCES translation_groups(id)
);
CREATE TABLE IF NOT EXISTS articles (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source_host VARCHAR(253) NOT NULL,
  source_post_id VARCHAR(30) NOT NULL,
  current_hash CHAR(64) NOT NULL,
  title VARCHAR(500) NOT NULL,
  canonical VARCHAR(1500) NOT NULL,
  category VARCHAR(200) NOT NULL DEFAULT '',
  status ENUM('publish','withdrawn') NOT NULL,
  published_at DATETIME(3) NOT NULL,
  modified_at DATETIME(3) NOT NULL,
  UNIQUE (source_host, source_post_id),
  INDEX (published_at),
  INDEX (current_hash)
);
CREATE TABLE IF NOT EXISTS article_versions (
  article_id INT UNSIGNED NOT NULL,
  source_hash CHAR(64) NOT NULL,
  payload JSON NOT NULL,
  PRIMARY KEY (article_id, source_hash),
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
CREATE TABLE IF NOT EXISTS webhook_logs (
  request_id VARCHAR(80) PRIMARY KEY,
  body_hash CHAR(64) NOT NULL,
  article_id INT UNSIGNED,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (article_id) REFERENCES articles(id)
);
CREATE TABLE IF NOT EXISTS daily_allocations (
  domain_id INT UNSIGNED NOT NULL,
  local_day DATE NOT NULL,
  used INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (domain_id, local_day),
  FOREIGN KEY (domain_id) REFERENCES domains(id)
);
CREATE TABLE IF NOT EXISTS translation_jobs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id INT UNSIGNED NOT NULL,
  domain_id INT UNSIGNED NOT NULL,
  source_hash CHAR(64) NOT NULL,
  provider_id INT UNSIGNED NOT NULL,
  fallback_provider_id INT UNSIGNED,
  priority SMALLINT UNSIGNED NOT NULL DEFAULT 10,
  state ENUM('pending','processing','retrying','review','published','failed','cancelled','skipped') NOT NULL DEFAULT 'pending',
  generation INT UNSIGNED NOT NULL DEFAULT 1,
  error_code VARCHAR(120),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE (article_id, domain_id, source_hash),
  INDEX (state, id),
  INDEX (created_at),
  FOREIGN KEY (article_id, source_hash) REFERENCES article_versions(article_id, source_hash),
  FOREIGN KEY (domain_id) REFERENCES domains(id),
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id),
  FOREIGN KEY (fallback_provider_id) REFERENCES translation_providers(id)
);
CREATE TABLE IF NOT EXISTS article_translations (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  article_id INT UNSIGNED NOT NULL,
  domain_id INT UNSIGNED NOT NULL,
  job_id INT UNSIGNED NOT NULL UNIQUE,
  slug VARCHAR(190) NOT NULL,
  title VARCHAR(500) NOT NULL,
  excerpt TEXT NOT NULL,
  content MEDIUMTEXT NOT NULL,
  seo_title VARCHAR(500) NOT NULL,
  seo_description TEXT NOT NULL,
  state ENUM('review','published','archived') NOT NULL,
  mock BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  INDEX (domain_id, state, updated_at),
  INDEX (domain_id, slug, state),
  INDEX (article_id, domain_id, state),
  FOREIGN KEY (article_id) REFERENCES articles(id),
  FOREIGN KEY (domain_id) REFERENCES domains(id),
  FOREIGN KEY (job_id) REFERENCES translation_jobs(id)
);
CREATE TABLE IF NOT EXISTS translation_memory (
  source_hash CHAR(64) NOT NULL,
  source_language VARCHAR(16) NOT NULL,
  target_language VARCHAR(16) NOT NULL,
  provider_id INT UNSIGNED NOT NULL,
  translated_text MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_hash, source_language, target_language, provider_id),
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id)
);
CREATE TABLE IF NOT EXISTS provider_usage (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  job_id INT UNSIGNED NOT NULL,
  provider_id INT UNSIGNED NOT NULL,
  characters INT UNSIGNED NOT NULL,
  cost_inr DECIMAL(16,6) NOT NULL,
  success BOOLEAN NOT NULL,
  is_fallback BOOLEAN NOT NULL,
  duration_ms INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX (created_at),
  FOREIGN KEY (job_id) REFERENCES translation_jobs(id),
  FOREIGN KEY (provider_id) REFERENCES translation_providers(id)
);
CREATE TABLE IF NOT EXISTS redirects (
  domain_id INT UNSIGNED NOT NULL,
  old_path VARCHAR(500) NOT NULL,
  new_path VARCHAR(500) NOT NULL,
  PRIMARY KEY (domain_id, old_path),
  FOREIGN KEY (domain_id) REFERENCES domains(id)
);
