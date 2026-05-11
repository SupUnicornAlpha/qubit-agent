CREATE TABLE IF NOT EXISTS `mcp_registry_source` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`auth_type` text DEFAULT 'none' NOT NULL,
	`auth_ref` text,
	`enabled` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sync_interval_sec` integer DEFAULT 300 NOT NULL,
	`last_synced_at` text,
	`last_error` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_mcp_registry_source_name_unique` ON `mcp_registry_source` (`name`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_catalog_item` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text DEFAULT '' NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`version` text DEFAULT 'latest' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'community' NOT NULL,
	`transport` text NOT NULL,
	`risk_level` text DEFAULT 'medium' NOT NULL,
	`spec_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `mcp_registry_source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_mcp_catalog_item_source_slug_unique` ON `mcp_catalog_item` (`source_id`,`slug`);
--> statement-breakpoint
ALTER TABLE `mcp_server_config` ADD COLUMN `project_id` text REFERENCES `project`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_tool_binding` ADD COLUMN `project_id` text REFERENCES `project`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` ADD COLUMN `project_id` text REFERENCES `project`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` ADD COLUMN `workspace_id` text REFERENCES `workspace`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` ADD COLUMN `source_id` text REFERENCES `mcp_registry_source`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` ADD COLUMN `catalog_item_id` text REFERENCES `mcp_catalog_item`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` ADD COLUMN `install_status` text DEFAULT 'installed' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_server_project_name` ON `mcp_server_config` (`project_id`,`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_binding_project_server_tool` ON `mcp_tool_binding` (`project_id`,`server_name`,`tool_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_install_project_created` ON `mcp_catalog_install` (`project_id`,`created_at`);
