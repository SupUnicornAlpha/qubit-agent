-- 0075: exec_call_log — Exec 能力源调用结构化日志
--
-- 背景：2026 "CLI vs MCP" hybrid 方案接入后，新增 builtin 工具 shell.exec / cli_agent.run。
--   - tool_call_log 已经记录工具调用本身（tool_name / status / latency / agent_definition_id），
--     但 request/response 是泛型 JSON，要切片"哪个 binary 调用最多 / 哪类 error 多发 / cwd 是否常逃逸"
--     必须 JSON 提取，不走索引。
--   - 仿照 mcp_call_log 同构落一张 exec_call_log，主键复用 tool_call_log.id（1:1），
--     这样监控页可以 `SELECT * FROM tool_call_log JOIN exec_call_log USING(id)` 平滑扩展，
--     不需要改动现有 tool_call_log 的 SELECT 路径。
--
-- 字段分类：
--   ─ 关联字段（与 tool_call_log / mcp_call_log 对齐）
--   ─ Provider 维度（exec 独有）：provider_id / exec_kind / binary
--   ─ 输入维度：args_json / cwd / stdin_bytes
--   ─ 输出维度：exit_code / stdout_bytes / stderr_bytes / truncated
--   ─ 状态维度：status / error_code / error_detail / latency_ms
--
-- 设计取舍：
--   - 不存 stdout/stderr 原文（可能 256KB 级，写库放大太大）；只存字节数。
--     真要看输出，可以从 tool_call_log.response_json 拿前几 KB（足够 debug）。
--   - error_code 是 ExecResult 的 5 种结构化码：
--     binary_not_found / binary_not_registered / cwd_escape / shell_metachar /
--     disallowed_subcommand / wall_timeout / output_truncated / nonzero_exit / exec_failed
--     —— 便于在监控页直接 GROUP BY error_code 出错误分布。
--   - status 沿用 tool_call_log 的 4 个枚举（success / error / timeout / sandbox_blocked），
--     让跨表 union 查询不需要枚举映射。

CREATE TABLE IF NOT EXISTS `exec_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL REFERENCES `workflow_run`(`id`),
	`agent_step_id` text NOT NULL REFERENCES `agent_step`(`id`),
	-- 监控 v3 P0 冗余：避免按 Agent 切分 timeseries 时多跳 join
	`agent_definition_id` text REFERENCES `agent_definition`(`id`),
	`trace_id` text,
	`retry_count` integer NOT NULL DEFAULT 0,

	-- Provider 维度（exec 独有）
	`provider_id` text NOT NULL,
	`exec_kind` text NOT NULL,
	`binary` text NOT NULL,

	-- 输入维度
	`args_json` text NOT NULL DEFAULT '[]',
	`cwd` text NOT NULL,
	`stdin_bytes` integer NOT NULL DEFAULT 0,

	-- 输出维度
	`exit_code` integer,
	`stdout_bytes` integer NOT NULL DEFAULT 0,
	`stderr_bytes` integer NOT NULL DEFAULT 0,
	`truncated` integer NOT NULL DEFAULT 0,

	-- 状态维度
	`status` text NOT NULL,
	`error_code` text,
	`error_detail` text,
	`latency_ms` integer,

	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,

	CHECK (`exec_kind` IN ('shell', 'cli_agent')),
	CHECK (`status` IN ('success', 'error', 'timeout', 'sandbox_blocked')),
	CHECK (`truncated` IN (0, 1))
);
--> statement-breakpoint

-- 监控页常用切片：按工作流 / 按 provider / 按时间窗 / 按 agent 定义
CREATE INDEX IF NOT EXISTS `idx_exec_call_log_workflow_created` ON `exec_call_log` (`workflow_run_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_exec_call_log_provider_created` ON `exec_call_log` (`provider_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_exec_call_log_status_created` ON `exec_call_log` (`status`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_exec_call_log_agent_def_created` ON `exec_call_log` (`agent_definition_id`, `created_at`);
