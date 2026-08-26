-- Persist chat image inputs separately from text so the model can receive a
-- multimodal content block without leaking base64 into the conversation text.
ALTER TABLE chat_message ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
