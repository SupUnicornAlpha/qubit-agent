-- M1: 因子-规则-策略 三段式骨架
-- 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1 §6.2 §6.3 §6.4
-- 因子值（按 symbol×date×factor 高基数）不进 SQLite，由 DuckDB+Parquet 承载（P1 阶段实现）
-- 本迁移只建 SQLite 控制面/元数据/评估表

-- factor_definition 已有（schema.ts L739），扩字段：
ALTER TABLE `factor_definition` ADD COLUMN `expr` text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `lang` text NOT NULL DEFAULT 'python';
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `universe` text NOT NULL DEFAULT 'CN-A';
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `horizon` integer NOT NULL DEFAULT 5;
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `status` text NOT NULL DEFAULT 'draft';
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `provider_key` text NOT NULL DEFAULT 'python_inline';
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_factor_definition_project_status`
  ON `factor_definition` (`project_id`, `status`);
--> statement-breakpoint

-- 因子质量评估（IC / RankIC / IR / 衰减 / 换手），跨阶段反复写入
CREATE TABLE IF NOT EXISTS `factor_evaluation` (
  `id` text PRIMARY KEY NOT NULL,
  `factor_id` text NOT NULL REFERENCES `factor_definition`(`id`) ON DELETE CASCADE,
  `asof` text NOT NULL,
  `universe` text NOT NULL,
  `provider_id` text,
  `ic` real,
  `rank_ic` real,
  `ir` real,
  `turnover` real,
  `decay_curve_json` text NOT NULL DEFAULT '[]',
  `group_returns_json` text NOT NULL DEFAULT '[]',
  `sample_size` integer NOT NULL DEFAULT 0,
  `latency_ms` integer NOT NULL DEFAULT 0,
  `error` text,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_factor_evaluation_factor_asof`
  ON `factor_evaluation` (`factor_id`, `asof` DESC);
--> statement-breakpoint

-- 规则定义：JSONLogic 子集 / Python，applies_to 决定挂在 select/filter/score/order/risk 的哪一段
CREATE TABLE IF NOT EXISTS `rule_definition` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`),
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `applies_to` text NOT NULL DEFAULT 'score',
  `lang` text NOT NULL DEFAULT 'jsonlogic',
  `dsl_json` text NOT NULL DEFAULT '{}',
  `status` text NOT NULL DEFAULT 'draft',
  `provider_key` text NOT NULL DEFAULT 'jsonlogic',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rule_definition_project_status`
  ON `rule_definition` (`project_id`, `status`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `rule_evaluation_log` (
  `id` text PRIMARY KEY NOT NULL,
  `rule_id` text NOT NULL REFERENCES `rule_definition`(`id`) ON DELETE CASCADE,
  `asof` text NOT NULL,
  `input_hash` text NOT NULL DEFAULT '',
  `output_json` text NOT NULL DEFAULT '{}',
  `sample_size` integer NOT NULL DEFAULT 0,
  `latency_ms` integer NOT NULL DEFAULT 0,
  `error` text,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rule_evaluation_log_rule_asof`
  ON `rule_evaluation_log` (`rule_id`, `asof` DESC);
--> statement-breakpoint

-- 策略组合：factor_ids + rule_ids + 权重方法 + 调仓频率 + 选股域
-- strategy.kind 走 strategy_version.paramSchemaJson 内的 type 字段，不强 ALTER 旧表枚举
CREATE TABLE IF NOT EXISTS `strategy_composition` (
  `id` text PRIMARY KEY NOT NULL,
  `strategy_version_id` text NOT NULL REFERENCES `strategy_version`(`id`) ON DELETE CASCADE,
  `kind` text NOT NULL DEFAULT 'factor_score',
  `factor_ids_json` text NOT NULL DEFAULT '[]',
  `rule_ids_json` text NOT NULL DEFAULT '[]',
  `weight_method` text NOT NULL DEFAULT 'equal',
  `rebalance_freq` text NOT NULL DEFAULT '1d',
  `universe` text NOT NULL DEFAULT 'CN-A',
  `params_json` text NOT NULL DEFAULT '{}',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_composition_sv`
  ON `strategy_composition` (`strategy_version_id`);
--> statement-breakpoint

-- 挖掘任务编排留痕：因子挖掘 / 规则挖掘 / 协演化
CREATE TABLE IF NOT EXISTS `discovery_job` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`),
  `workflow_run_id` text,
  `kind` text NOT NULL,
  `input_json` text NOT NULL DEFAULT '{}',
  `output_json` text NOT NULL DEFAULT '{}',
  `status` text NOT NULL DEFAULT 'pending',
  `error` text,
  `started_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` text,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_discovery_job_project_status`
  ON `discovery_job` (`project_id`, `status`, `started_at` DESC);
--> statement-breakpoint

-- backtest_run 增加 provider 标记，留痕走的是哪个回测 Provider
ALTER TABLE `backtest_run` ADD COLUMN `provider_id` text;
--> statement-breakpoint
ALTER TABLE `backtest_run` ADD COLUMN `engine_key` text NOT NULL DEFAULT 'sma_legacy';
