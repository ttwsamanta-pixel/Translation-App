ALTER TABLE translation_providers
  MODIFY COLUMN adapter ENUM('deepl','mock','google_cloud','gemini','openai') NOT NULL,
  ADD COLUMN model VARCHAR(120) NULL AFTER adapter;
