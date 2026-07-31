-- Durable, workflow-scoped facts for A2A re-dispatch and checkpoint resume.
CREATE TABLE `workflow_artifact_ledger` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_run_id` text NOT NULL,
  `fingerprint` text NOT NULL,
  `artifact_kind` text NOT NULL,
  `tool_name` text NOT NULL,
  `payload_json` text DEFAULT '{}' NOT NULL,
  `producer_task_id` text,
  `as_of` text,
  `freshness_ms` integer,
  `expires_at` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_workflow_artifact_ledger_fingerprint`
  ON `workflow_artifact_ledger` (`workflow_run_id`,`fingerprint`);
--> statement-breakpoint
CREATE INDEX `idx_workflow_artifact_ledger_reusable`
  ON `workflow_artifact_ledger` (`workflow_run_id`,`expires_at`,`created_at`);
