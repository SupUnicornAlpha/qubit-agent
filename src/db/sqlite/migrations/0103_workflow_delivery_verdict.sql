-- Append-only DeliveryVerdict ledger (lifecycle status stays on workflow_run).
CREATE TABLE IF NOT EXISTS `workflow_delivery_verdict` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT NOT NULL REFERENCES `workflow_run`(`id`),
  `state` TEXT NOT NULL CHECK(
    `state` IN ('delivered', 'delivered_with_gaps', 'partial', 'failed')
  ),
  `reason_codes_json` TEXT NOT NULL DEFAULT '[]',
  `missing_artifacts_json` TEXT NOT NULL DEFAULT '[]',
  `missing_capabilities_json` TEXT NOT NULL DEFAULT '[]',
  `data_gaps_json` TEXT NOT NULL DEFAULT '[]',
  `answer_json` TEXT NOT NULL DEFAULT '{}',
  `evaluator_version` TEXT NOT NULL,
  `recipe_key` TEXT,
  `recipe_version` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_delivery_verdict_workflow`
  ON `workflow_delivery_verdict` (`workflow_run_id`, `created_at` DESC);
