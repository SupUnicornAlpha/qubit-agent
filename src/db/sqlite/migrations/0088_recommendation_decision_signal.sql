-- 0088_recommendation_decision_signal
--
-- 把 recommendation_snapshot 从“方向快照”升级为可执行、可验证的 DecisionSignal。

-- 0087 的早期版本缺少 statement breakpoint，已升级数据库可能只创建了第一张表。
-- 这里先做幂等修复，再扩展字段；新安装数据库也安全。
CREATE TABLE IF NOT EXISTS `recommendation_outcome` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `recommendation_id` TEXT NOT NULL REFERENCES `recommendation_snapshot`(`id`) ON DELETE CASCADE,
  `horizon_days` INTEGER NOT NULL,
  `start_price` REAL,
  `end_price` REAL,
  `return_pct` REAL,
  `benchmark_return_pct` REAL,
  `excess_return_pct` REAL,
  `hit` INTEGER,
  `outcome` TEXT NOT NULL DEFAULT 'pending'
    CHECK (`outcome` IN ('pending', 'win', 'loss', 'flat', 'invalid')),
  `evaluated_at` TEXT,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_recommendation_outcome_unique`
  ON `recommendation_outcome` (`recommendation_id`, `horizon_days`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `strategy_eval_run` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT REFERENCES `workflow_run`(`id`) ON DELETE SET NULL,
  `project_id` TEXT NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `strategy_version_id` TEXT REFERENCES `strategy_version`(`id`) ON DELETE SET NULL,
  `composition_id` TEXT REFERENCES `strategy_composition`(`id`) ON DELETE SET NULL,
  `backtest_run_id` TEXT REFERENCES `backtest_run`(`id`) ON DELETE SET NULL,
  `scenario_key` TEXT NOT NULL DEFAULT '',
  `eval_kind` TEXT NOT NULL DEFAULT 'backtest'
    CHECK (`eval_kind` IN ('backtest', 'paper', 'live', 'walk_forward', 'recommendation')),
  `period_start` TEXT,
  `period_end` TEXT,
  `metrics_json` TEXT NOT NULL DEFAULT '{}',
  `quality_score` REAL,
  `pass` INTEGER,
  `notes` TEXT NOT NULL DEFAULT '',
  `created_by` TEXT NOT NULL DEFAULT 'system',
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_eval_run_workflow`
  ON `strategy_eval_run` (`workflow_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_eval_run_strategy`
  ON `strategy_eval_run` (`strategy_version_id`, `created_at`);
--> statement-breakpoint

ALTER TABLE `recommendation_snapshot` ADD COLUMN `entry_low` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `entry_high` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `stop_loss` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `take_profit` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `position_size_pct` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `risk_reward_ratio` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `invalidation_json` TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `watch_conditions_json` TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `benchmark_symbol` TEXT;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `status` TEXT NOT NULL DEFAULT 'active'
  CHECK (`status` IN ('draft', 'active', 'closed', 'expired', 'invalidated'));
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `expires_at` TEXT;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `data_asof` TEXT;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` ADD COLUMN `engine_version` TEXT NOT NULL DEFAULT 'decision-signal-v1';
--> statement-breakpoint

ALTER TABLE `recommendation_outcome` ADD COLUMN `entry_price` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `exit_price` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `exit_reason` TEXT;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `max_favorable_excursion_pct` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `max_adverse_excursion_pct` REAL;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `stop_loss_triggered` INTEGER;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `take_profit_triggered` INTEGER;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `ambiguous_bar` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `bars_observed` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `evaluation_error` TEXT;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` ADD COLUMN `engine_version` TEXT NOT NULL DEFAULT 'decision-signal-v1';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_recommendation_snapshot_project_status_asof`
  ON `recommendation_snapshot` (`project_id`, `status`, `asof`);
