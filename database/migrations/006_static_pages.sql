ALTER TABLE articles ADD COLUMN content_type ENUM('post','page') NOT NULL DEFAULT 'post', ADD INDEX article_type_date (content_type,published_at);
UPDATE articles a JOIN article_versions v ON v.article_id=a.id AND v.source_hash=a.current_hash
SET a.content_type='page' WHERE JSON_UNQUOTE(JSON_EXTRACT(v.payload,'$.articleType'))='page';
