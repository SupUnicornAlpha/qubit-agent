-- 加速工作流列表 / 选择器查询：
--   1) 列表常按 startedAt（实际列名是 `created_at`）DESC 排序：覆盖单列索引让 ORDER BY 走索引扫描而非全表排序。
--   2) 工作流详情 / 监控页常按 session_id + 创建时间过滤：联合索引避免回表 + sort。
--   3) status / mode 过滤是低基数列，单独加索引收益有限，但与时间组合可显著提升「running / failed + 最近」类查询。
--   4) project_id + 时间用于按项目过滤的工作流列表（前端工作流选择器在 multi-project 模式下使用）。
--   5) chat_session 列表按 workspace_id + (project_id) + updated_at DESC 排序：补充复合索引。
--   6) chat_message(session_id, created_at) 用于硬删除按会话拉消息时走索引。
-- 注：所有索引使用 IF NOT EXISTS，确保旧库幂等升级。
-- 注：drizzle 中 `workflowRun.startedAt` 实际映射到 SQLite 列 `created_at`（见 schema.ts 中的 `createdAt()` helper）。

CREATE INDEX IF NOT EXISTS `idx_workflow_run_created_at`
  ON `workflow_run` (`created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_run_session_created`
  ON `workflow_run` (`session_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_run_project_created`
  ON `workflow_run` (`project_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_run_status_created`
  ON `workflow_run` (`status`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_workflow_run_mode_created`
  ON `workflow_run` (`mode`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_session_workspace_updated`
  ON `chat_session` (`workspace_id`, `updated_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_session_project_updated`
  ON `chat_session` (`project_id`, `updated_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_chat_message_session_created`
  ON `chat_message` (`session_id`, `created_at` DESC);
