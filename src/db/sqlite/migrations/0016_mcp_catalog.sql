CREATE TABLE IF NOT EXISTS `mcp_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'community' NOT NULL,
	`source` text DEFAULT 'builtin' NOT NULL,
	`risk_level` text DEFAULT 'medium' NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`url` text,
	`default_tool_name` text DEFAULT '' NOT NULL,
	`default_timeout_ms` integer DEFAULT 20000 NOT NULL,
	`default_retry_policy_json` text DEFAULT '{}' NOT NULL,
	`default_rate_limit_json` text DEFAULT '{}' NOT NULL,
	`default_capabilities_json` text DEFAULT '[]' NOT NULL,
	`setup_schema_json` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_mcp_catalog_slug_unique` ON `mcp_catalog` (`slug`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mcp_catalog_install` (
	`id` text PRIMARY KEY NOT NULL,
	`catalog_id` text NOT NULL,
	`server_name` text NOT NULL,
	`status` text DEFAULT 'installed' NOT NULL,
	`error_message` text,
	`installed_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`catalog_id`) REFERENCES `mcp_catalog`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_catalog_install_catalog_created` ON `mcp_catalog_install` (`catalog_id`,`created_at`);
