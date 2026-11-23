ALTER TABLE users MODIFY role ENUM(
  'super_admin','admin','editor','translation_manager','technical','content_manager','domain_manager','seo_manager','viewer'
) NOT NULL;
