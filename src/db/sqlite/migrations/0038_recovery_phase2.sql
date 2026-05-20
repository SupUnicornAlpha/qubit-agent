-- Phase 2 持久化能力：
-- 1. agent_checkpoint_snapshot：旁路存放序列化的 ReAct GraphState（节点边界一行），
--    与 langgraph_checkpoint blob 互为冗余，便于运营查询、跨版本兜底。
-- 2. workflow_run 扩展 CLI session 元数据，支持 `claude --resume` / `codex exec resume`。

CREATE TABLE IF NOT EXISTS `agent_checkpoint_snapshot` (
  `id` text PRIMARY KEY NOT NULL,
  `workflow_run_id` text NOT NULL REFERENCES `workflow_run`(`id`),
  `agent_instance_id` text NOT NULL REFERENCES `agent_instance`(`id`),
  `run_id` text NOT NULL,
  `step_index` integer NOT NULL,
  `phase` text NOT NULL,
  `iteration` integer NOT NULL DEFAULT 0,
  `snapshot_json` text NOT NULL,
  `state_hash` text,
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_checkpoint_snapshot_workflow`
  ON `agent_checkpoint_snapshot` (`workflow_run_id`, `step_index` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_checkpoint_snapshot_run`
  ON `agent_checkpoint_snapshot` (`run_id`, `step_index` DESC);
--> statement-breakpoint

ALTER TABLE `workflow_run` ADD COLUMN `cli_session_id` text;
--> statement-breakpoint
ALTER TABLE `workflow_run` ADD COLUMN `cli_loop_command` text;
--> statement-breakpoint
ALTER TABLE `workflow_run` ADD COLUMN `cli_session_resumed_count` integer NOT NULL DEFAULT 0;
