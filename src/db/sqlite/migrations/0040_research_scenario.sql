-- M1: 研究场景注册中心
-- 把研究团队从「分析辩论 + 策略撰写」扩展为多专业场景研究台
-- 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.6

CREATE TABLE IF NOT EXISTS `research_scenario` (
  `id` text PRIMARY KEY NOT NULL,
  `key` text NOT NULL,
  `display_name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `default_agent_group_id` text,
  `input_schema_json` text NOT NULL DEFAULT '{}',
  `output_contract_json` text NOT NULL DEFAULT '{}',
  `required_capabilities_json` text NOT NULL DEFAULT '[]',
  `tool_preset_json` text NOT NULL DEFAULT '{}',
  `loop_defaults_json` text NOT NULL DEFAULT '{}',
  `status` text NOT NULL DEFAULT 'enabled',
  `sort_order` integer NOT NULL DEFAULT 100,
  `is_builtin` integer NOT NULL DEFAULT 0,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_research_scenario_key`
  ON `research_scenario` (`key`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_research_scenario_status_sort`
  ON `research_scenario` (`status`, `sort_order`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `research_scenario_group` (
  `id` text PRIMARY KEY NOT NULL,
  `scenario_id` text NOT NULL REFERENCES `research_scenario`(`id`) ON DELETE CASCADE,
  `agent_group_id` text NOT NULL,
  `is_default` integer NOT NULL DEFAULT 0,
  `sort_order` integer NOT NULL DEFAULT 100,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_research_scenario_group_unique`
  ON `research_scenario_group` (`scenario_id`, `agent_group_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_research_scenario_group_scenario`
  ON `research_scenario_group` (`scenario_id`, `sort_order`);
--> statement-breakpoint

-- workflow_run 增加场景标签，便于产物归类与监控
-- 旧 workflow 无场景 → runtime 视作 analyst_debate（默认兜底）
ALTER TABLE `workflow_run` ADD COLUMN `research_scenario_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_run_research_scenario`
  ON `workflow_run` (`research_scenario_id`);
