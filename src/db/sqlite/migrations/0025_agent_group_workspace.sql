ALTER TABLE `agent_group` ADD COLUMN `workspace_id` text REFERENCES `workspace`(`id`) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE `agent_group` ADD COLUMN `relations_json` text DEFAULT '[]' NOT NULL;
