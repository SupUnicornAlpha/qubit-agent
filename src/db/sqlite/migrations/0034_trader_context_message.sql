CREATE TABLE `trader_context_message` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_run_id` text NOT NULL REFERENCES `workflow_run`(`id`) ON DELETE CASCADE,
  `source_id` text,
  `role` text NOT NULL,
  `kind` text NOT NULL,
  `title` text NOT NULL DEFAULT '',
  `body` text NOT NULL DEFAULT '',
  `payload_json` text DEFAULT '{}' NOT NULL,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE INDEX `idx_trader_ctx_wf_created` ON `trader_context_message` (`workflow_run_id`, `created_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_trader_ctx_wf_source` ON `trader_context_message` (`workflow_run_id`, `source_id`);
