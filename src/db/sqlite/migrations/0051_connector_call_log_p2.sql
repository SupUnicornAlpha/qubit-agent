-- 监控 V2 P2 — connector_call_log 升级（详见 docs/MONITORING_V2_DESIGN.md §4.1.5）
--
-- 现状：connectorCallLog.connector_instance_id 是 NOT NULL 强外键，
-- 但 ACP 调用上下文（act.ts → AcpCaller → registry.dispatchAcpCall）只知道
-- 「connector 名字」，不一定有持久化 connector_instance 行（市场行情 / 新闻
-- 类无状态 connector 永远没 instance）。
--
-- 改动：
--   1) connector_instance_id 改为 NULLABLE（保持 FK，但 NULL 表示「无 instance」）
--   2) 新增 connector_name TEXT NOT NULL — 反正每条都要知道是哪个 connector
--   3) 新增 workflow_run_id（与 tool_call_log P1 升级对齐，便于跨表 union）
--   4) 新增 error_message — 失败时的 error message 摘要
--
-- SQLite 无 ALTER COLUMN，只能 create + rename + drop 三步走（FK 也需重新指）。

PRAGMA foreign_keys = OFF;
--> statement-breakpoint

CREATE TABLE `connector_call_log_new` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `connector_instance_id` TEXT REFERENCES `connector_instance`(`id`),
  `connector_name` TEXT NOT NULL DEFAULT '',
  `workflow_run_id` TEXT REFERENCES `workflow_run`(`id`),
  `acp_call_id` TEXT REFERENCES `acp_call`(`id`),
  `trace_id` TEXT NOT NULL,
  `operation` TEXT NOT NULL,
  `request_json` TEXT NOT NULL,
  `response_json` TEXT,
  `latency_ms` INTEGER NOT NULL,
  `status` TEXT NOT NULL,
  `error_message` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

-- 老数据迁移：connector_name 留空（无来源；新写入路径会填）
INSERT INTO `connector_call_log_new`
  (id, connector_instance_id, connector_name, workflow_run_id, acp_call_id,
   trace_id, operation, request_json, response_json, latency_ms, status, created_at)
SELECT
  id, connector_instance_id, '', NULL, acp_call_id,
  trace_id, operation, request_json, response_json, latency_ms, status, created_at
FROM `connector_call_log`;
--> statement-breakpoint

DROP TABLE `connector_call_log`;
--> statement-breakpoint
ALTER TABLE `connector_call_log_new` RENAME TO `connector_call_log`;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_connector_call_log_workflow_created`
  ON `connector_call_log` (`workflow_run_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_connector_call_log_name_status_created`
  ON `connector_call_log` (`connector_name`, `status`, `created_at` DESC);
--> statement-breakpoint

PRAGMA foreign_keys = ON;
