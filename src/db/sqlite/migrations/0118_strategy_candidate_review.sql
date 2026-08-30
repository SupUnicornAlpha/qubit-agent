CREATE TABLE IF NOT EXISTS `strategy_candidate_review` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
  `strategy_version_id` text NOT NULL REFERENCES `strategy_version`(`id`) ON UPDATE no action ON DELETE cascade,
  `comparison_cohort_id` text NOT NULL,
  `decision` text NOT NULL DEFAULT 'incomplete',
  `reason_codes_json` text NOT NULL DEFAULT '[]',
  `duplicate_of_strategy_version_id` text REFERENCES `strategy_version`(`id`) ON UPDATE no action ON DELETE set null,
  `regime_evidence_json` text NOT NULL DEFAULT '[]',
  `capacity_evidence_json` text NOT NULL DEFAULT '{}',
  `correlation_evidence_json` text NOT NULL DEFAULT '{}',
  `created_by` text NOT NULL DEFAULT 'system',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_strategy_candidate_review_unique`
  ON `strategy_candidate_review` (`project_id`, `strategy_version_id`, `comparison_cohort_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_candidate_review_project_decision`
  ON `strategy_candidate_review` (`project_id`, `decision`, `updated_at`);
