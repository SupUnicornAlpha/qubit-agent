CREATE TABLE `strategy_eval_run_new` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT REFERENCES `workflow_run`(`id`) ON DELETE SET NULL,
  `project_id` TEXT NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `strategy_version_id` TEXT REFERENCES `strategy_version`(`id`) ON DELETE SET NULL,
  `composition_id` TEXT REFERENCES `strategy_composition`(`id`) ON DELETE SET NULL,
  `backtest_run_id` TEXT REFERENCES `backtest_run`(`id`) ON DELETE SET NULL,
  `scenario_key` TEXT NOT NULL DEFAULT '',
  `eval_kind` TEXT NOT NULL DEFAULT 'backtest'
    CHECK (`eval_kind` IN ('backtest', 'paper', 'live', 'walk_forward', 'holdout', 'recommendation')),
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
INSERT INTO `strategy_eval_run_new` (
  `id`, `workflow_run_id`, `project_id`, `strategy_version_id`, `composition_id`, `backtest_run_id`,
  `scenario_key`, `eval_kind`, `period_start`, `period_end`, `metrics_json`, `quality_score`,
  `pass`, `notes`, `created_by`, `created_at`
)
SELECT
  `id`, `workflow_run_id`, `project_id`, `strategy_version_id`, `composition_id`, `backtest_run_id`,
  `scenario_key`, `eval_kind`, `period_start`, `period_end`, `metrics_json`, `quality_score`,
  `pass`, `notes`, `created_by`, `created_at`
FROM `strategy_eval_run`;
--> statement-breakpoint
DROP TABLE `strategy_eval_run`;
--> statement-breakpoint
ALTER TABLE `strategy_eval_run_new` RENAME TO `strategy_eval_run`;
--> statement-breakpoint
CREATE INDEX `idx_strategy_eval_run_workflow`
  ON `strategy_eval_run` (`workflow_run_id`);
--> statement-breakpoint
CREATE INDEX `idx_strategy_eval_run_strategy`
  ON `strategy_eval_run` (`strategy_version_id`, `created_at`);
