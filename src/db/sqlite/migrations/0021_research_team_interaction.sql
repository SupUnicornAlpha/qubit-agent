CREATE TABLE IF NOT EXISTS `research_team_interaction` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_run_id` text NOT NULL REFERENCES `workflow_run`(`id`) ON DELETE CASCADE,
  `from_role` text NOT NULL,
  `to_role` text NOT NULL,
  `kind` text NOT NULL,
  `tool_kind` text,
  `tool_name` text,
  `content_text` text NOT NULL DEFAULT '',
  `payload_json` text DEFAULT '{}' NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
  CONSTRAINT research_team_interaction_kind_check CHECK(`kind` IN ('llm_message','tool_call','signal_submit'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_research_team_interaction_wf` ON `research_team_interaction` (`workflow_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_research_team_interaction_pair` ON `research_team_interaction` (`workflow_run_id`, `from_role`, `to_role`);
