-- Align mcp_call_log.status CHECK with drizzle schema + tool-call-log-service.
-- Writer inserts status='running' at call start; the 0010 CHECK only allowed
-- success|timeout|failed|sandbox_blocked and crashed MCP paths with:
--   CHECK constraint failed: status IN (...)
-- SQLite cannot ALTER CHECK in place → rebuild table.

CREATE TABLE IF NOT EXISTS `mcp_call_log__0102` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT NOT NULL REFERENCES `workflow_run`(`id`),
  `agent_step_id` TEXT NOT NULL REFERENCES `agent_step`(`id`),
  `agent_definition_id` TEXT REFERENCES `agent_definition`(`id`),
  `server_name` TEXT NOT NULL,
  `tool_name` TEXT NOT NULL,
  `trace_id` TEXT,
  `retry_count` INTEGER NOT NULL DEFAULT 0,
  `transport` TEXT,
  `circuit_state` TEXT,
  `request_json` TEXT NOT NULL,
  `response_json` TEXT,
  `status` TEXT NOT NULL CHECK(
    `status` IN ('running', 'success', 'timeout', 'failed', 'sandbox_blocked')
  ),
  `error_code` TEXT,
  `latency_ms` INTEGER,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
INSERT INTO `mcp_call_log__0102` (
  `id`,
  `workflow_run_id`,
  `agent_step_id`,
  `agent_definition_id`,
  `server_name`,
  `tool_name`,
  `trace_id`,
  `retry_count`,
  `transport`,
  `circuit_state`,
  `request_json`,
  `response_json`,
  `status`,
  `error_code`,
  `latency_ms`,
  `created_at`
)
SELECT
  `id`,
  `workflow_run_id`,
  `agent_step_id`,
  `agent_definition_id`,
  `server_name`,
  `tool_name`,
  `trace_id`,
  coalesce(`retry_count`, 0),
  `transport`,
  `circuit_state`,
  `request_json`,
  `response_json`,
  CASE
    WHEN `status` IN ('running', 'success', 'timeout', 'failed', 'sandbox_blocked') THEN `status`
    WHEN `status` IN ('error', 'governance_blocked') THEN 'failed'
    ELSE 'failed'
  END,
  `error_code`,
  `latency_ms`,
  `created_at`
FROM `mcp_call_log`;
--> statement-breakpoint
DROP TABLE `mcp_call_log`;
--> statement-breakpoint
ALTER TABLE `mcp_call_log__0102` RENAME TO `mcp_call_log`;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_workflow`
  ON `mcp_call_log` (`workflow_run_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_step`
  ON `mcp_call_log` (`agent_step_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_server_created`
  ON `mcp_call_log` (`server_name`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_workflow_created`
  ON `mcp_call_log` (`workflow_run_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_agent_def_created`
  ON `mcp_call_log` (`agent_definition_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_circuit_created`
  ON `mcp_call_log` (`circuit_state`, `created_at` DESC);
