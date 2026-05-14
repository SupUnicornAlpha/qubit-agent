-- Agent 包：SQL 元数据扩展 + 记忆按 definition 隔离
ALTER TABLE `agent_profile` ADD COLUMN `config_root_uri` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_profile` ADD COLUMN `memory_namespace` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_profile` ADD COLUMN `prompt_mode` text DEFAULT 'db_primary' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_profile` ADD COLUMN `config_content_hash` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `agent_profile` ADD COLUMN `config_synced_at` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `midterm_memory` ADD COLUMN `definition_id` text REFERENCES agent_definition(id) ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE `longterm_memory` ADD COLUMN `definition_id` text REFERENCES agent_definition(id) ON DELETE SET NULL ON UPDATE NO ACTION;
