-- 0087_research_effect_validation
--
-- 持续验证量化 agent 效果的事实表：
--   1. recommendation_snapshot：agent 在某 workflow 中给出的股票推荐快照
--   2. recommendation_outcome：推荐在 1d/5d/20d 等窗口的后验表现
--   3. strategy_eval_run：策略/组合的一次效果评估摘要（通常指向 backtest_run）

CREATE TABLE IF NOT EXISTS `recommendation_snapshot` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT NOT NULL REFERENCES `workflow_run`(`id`) ON DELETE CASCADE,
  `project_id` TEXT NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `scenario_key` TEXT NOT NULL,
  `symbol` TEXT NOT NULL,
  `market` TEXT NOT NULL DEFAULT 'US',
  `side` TEXT NOT NULL CHECK (`side` IN ('long', 'short', 'neutral')),
  `horizon_days` INTEGER NOT NULL DEFAULT 20,
  `confidence` REAL NOT NULL DEFAULT 0.5,
  `score` REAL,
  `rationale` TEXT NOT NULL DEFAULT '',
  `evidence_json` TEXT NOT NULL DEFAULT '[]',
  `source_artifact_kind` TEXT,
  `source_artifact_id` TEXT,
  `created_by` TEXT NOT NULL DEFAULT 'agent',
  `agent_instance_id` TEXT,
  `asof` TEXT NOT NULL,
  `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS `idx_recommendation_snapshot_workflow`
  ON `recommendation_snapshot` (`workflow_run_id`);

CREATE INDEX IF NOT EXISTS `idx_recommendation_snapshot_project_symbol`
  ON `recommendation_snapshot` (`project_id`, `symbol`, `asof`);

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

CREATE UNIQUE INDEX IF NOT EXISTS `idx_recommendation_outcome_unique`
  ON `recommendation_outcome` (`recommendation_id`, `horizon_days`);

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

CREATE INDEX IF NOT EXISTS `idx_strategy_eval_run_workflow`
  ON `strategy_eval_run` (`workflow_run_id`);

CREATE INDEX IF NOT EXISTS `idx_strategy_eval_run_strategy`
  ON `strategy_eval_run` (`strategy_version_id`, `created_at`);
