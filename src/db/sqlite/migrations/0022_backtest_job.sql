CREATE TABLE IF NOT EXISTS `backtest_job` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'queued' NOT NULL,
  `kind` text NOT NULL,
  `params_json` text DEFAULT '{}' NOT NULL,
  `result_json` text,
  `error` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CONSTRAINT backtest_job_status_check CHECK(`status` IN ('queued','running','completed','failed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backtest_job_status_created` ON `backtest_job` (`status`,`created_at`);
