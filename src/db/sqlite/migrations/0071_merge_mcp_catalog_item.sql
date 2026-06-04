-- Schema 收敛 C4：把 `mcp_catalog_item` 并入 `mcp_catalog`。
--
-- 之前两表 95% 字段重叠：mcp_catalog_item 的 specJson JSON blob 里存的字段
-- (command / url / defaultToolName / defaults / setupSchema) 全部是
-- mcp_catalog 顶级列；market-service.installCatalogItemToProject 在装机时
-- 做 shadow-copy 把 item 复制到 catalog，证明它们是同一对象的两种视图。
--
-- 合表方案：
--   - mcp_catalog 加 source_id / external_id / version 三列（registry 来源用）
--   - 新唯一索引 (source, COALESCE(source_id,''), slug)：不同来源允许同 slug
--   - 把 mcp_catalog_item 现有行展平 specJson 后 INSERT 到 mcp_catalog
--     (source='registry')；已存在的 id（market-service shadow-copy 已建过）跳过
--   - 删 mcp_catalog_item 表
--   - 删 mcp_catalog_install.catalog_item_id 列（FK 目标已无）

ALTER TABLE `mcp_catalog` ADD COLUMN `source_id` text REFERENCES `mcp_registry_source`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_catalog` ADD COLUMN `external_id` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `mcp_catalog` ADD COLUMN `version` text DEFAULT 'latest' NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_mcp_catalog_slug_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_mcp_catalog_source_slug` ON `mcp_catalog` (`source`, COALESCE(`source_id`, ''), `slug`);
--> statement-breakpoint
INSERT INTO `mcp_catalog` (
	`id`, `slug`, `name`, `description`, `provider`, `source`, `source_id`,
	`external_id`, `version`, `risk_level`, `transport`, `command`, `url`,
	`default_tool_name`, `default_timeout_ms`, `default_retry_policy_json`,
	`default_rate_limit_json`, `default_capabilities_json`, `setup_schema_json`,
	`enabled`, `created_at`, `updated_at`
)
SELECT
	item.`id`,
	item.`slug`,
	item.`name`,
	COALESCE(item.`description`, ''),
	COALESCE(item.`provider`, 'community'),
	'registry',
	item.`source_id`,
	COALESCE(item.`external_id`, ''),
	COALESCE(item.`version`, 'latest'),
	COALESCE(item.`risk_level`, 'medium'),
	item.`transport`,
	json_extract(item.`spec_json`, '$.command'),
	json_extract(item.`spec_json`, '$.url'),
	COALESCE(json_extract(item.`spec_json`, '$.defaultToolName'), ''),
	COALESCE(CAST(json_extract(item.`spec_json`, '$.defaultTimeoutMs') AS INTEGER), 20000),
	COALESCE(json_extract(item.`spec_json`, '$.defaultRetryPolicyJson'), '{}'),
	COALESCE(json_extract(item.`spec_json`, '$.defaultRateLimitJson'), '{}'),
	COALESCE(json_extract(item.`spec_json`, '$.defaultCapabilitiesJson'), '[]'),
	COALESCE(json_extract(item.`spec_json`, '$.setupSchemaJson'), '{}'),
	item.`enabled`,
	item.`created_at`,
	item.`updated_at`
FROM `mcp_catalog_item` AS item
WHERE NOT EXISTS (
	SELECT 1 FROM `mcp_catalog` c WHERE c.`id` = item.`id`
);
--> statement-breakpoint
ALTER TABLE `mcp_catalog_install` DROP COLUMN `catalog_item_id`;
--> statement-breakpoint
DROP TABLE `mcp_catalog_item`;
