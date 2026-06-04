-- Rollback for 0071_merge_mcp_catalog_item.sql：把 `mcp_catalog_item` 重建出来，
-- 从合表里把 source='registry' 的行抽回去（specJson 反向打回 JSON blob），
-- 然后还原 mcp_catalog.catalog_item_id 列与原唯一索引。
--
-- 注意：mcp_catalog 上新加的 source_id / external_id / version 列没有 DROP；
-- SQLite 3.35+ 虽然支持 DROP COLUMN，但 source_id 列有 FK 引用 mcp_registry_source，
-- 业务上保留这三列也不会影响 builtin 行（source_id=NULL, external_id='',
-- version='latest'）。要彻底还原可以再写一次 ALTER TABLE ... DROP COLUMN。

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
INSERT INTO `mcp_catalog_item` (
	`id`, `source_id`, `external_id`, `slug`, `name`, `version`, `description`,
	`provider`, `transport`, `risk_level`, `spec_json`, `enabled`,
	`created_at`, `updated_at`
)
SELECT
	`id`,
	`source_id`,
	`external_id`,
	`slug`,
	`name`,
	`version`,
	`description`,
	`provider`,
	`transport`,
	`risk_level`,
	json_object(
		'command', `command`,
		'url', `url`,
		'defaultToolName', `default_tool_name`,
		'defaultTimeoutMs', `default_timeout_ms`,
		'defaultRetryPolicyJson', json(`default_retry_policy_json`),
		'defaultRateLimitJson', json(`default_rate_limit_json`),
		'defaultCapabilitiesJson', json(`default_capabilities_json`),
		'setupSchemaJson', json(`setup_schema_json`)
	),
	`enabled`,
	`created_at`,
	`updated_at`
FROM `mcp_catalog` WHERE `source` = 'registry' AND `source_id` IS NOT NULL;
--> statement-breakpoint
DELETE FROM `mcp_catalog` WHERE `source` = 'registry';
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_catalog_source_slug`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_mcp_catalog_slug_unique` ON `mcp_catalog` (`slug`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` ADD COLUMN `catalog_item_id` text REFERENCES `mcp_catalog_item`(`id`);
