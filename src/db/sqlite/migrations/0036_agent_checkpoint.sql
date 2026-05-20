-- LangGraph checkpointer 持久化表。
-- 每个 workflow_run 对应一个 thread（thread_id = workflow_run.id），
-- 每个节点边界写一个 checkpoint 行；pending writes 单独表用于节点中断恢复。

CREATE TABLE IF NOT EXISTS `langgraph_checkpoint` (
  `thread_id` text NOT NULL,
  `checkpoint_ns` text NOT NULL DEFAULT '',
  `checkpoint_id` text NOT NULL,
  `parent_checkpoint_id` text,
  `type` text NOT NULL DEFAULT 'json',
  `checkpoint_blob` text NOT NULL,
  `metadata_blob` text NOT NULL,
  `created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (`thread_id`, `checkpoint_ns`, `checkpoint_id`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_langgraph_checkpoint_thread`
  ON `langgraph_checkpoint` (`thread_id`, `checkpoint_ns`, `checkpoint_id`);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS `langgraph_checkpoint_write` (
  `thread_id` text NOT NULL,
  `checkpoint_ns` text NOT NULL DEFAULT '',
  `checkpoint_id` text NOT NULL,
  `task_id` text NOT NULL,
  `idx` integer NOT NULL,
  `channel` text NOT NULL,
  `type` text NOT NULL DEFAULT 'json',
  `value_blob` text NOT NULL,
  `created_at` text NOT NULL DEFAULT (CURRENT_TIMESTAMP),
  PRIMARY KEY (`thread_id`, `checkpoint_ns`, `checkpoint_id`, `task_id`, `idx`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_langgraph_checkpoint_write_thread`
  ON `langgraph_checkpoint_write` (`thread_id`, `checkpoint_ns`, `checkpoint_id`);
--> statement-breakpoint

-- workflow_run 上记录当前活跃的 LangGraph checkpoint，便于启动 sweep 与续跑判断。
ALTER TABLE `workflow_run` ADD COLUMN `langgraph_thread_id` text;
--> statement-breakpoint
ALTER TABLE `workflow_run` ADD COLUMN `last_checkpoint_id` text;
--> statement-breakpoint
ALTER TABLE `workflow_run` ADD COLUMN `last_checkpoint_at` text;
--> statement-breakpoint
ALTER TABLE `workflow_run` ADD COLUMN `resume_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_run_status_ended`
  ON `workflow_run` (`status`, `ended_at`);
