-- 监控 V3 P0 — 时序聚合（timeseries）基建：高频日志表加 Agent 维度冗余 + MCP transport / circuit_state
--
-- 背景：
--   - v2 之前的所有 /monitor/* 端点都只返回"窗口内合计"标量，没有时间分桶（timeseries）。
--     要做"近 24h 按小时分桶画曲线"前端没有数据来源。
--   - timeseries 端点（/api/v1/monitor/timeseries）会按 groupBy=agentDefinitionId 分组，
--     而 llm_call_log / tool_call_log / mcp_call_log 都没 agent_definition_id 列，
--     聚合就被迫 3 跳 join（…→ agent_step → agent_instance → agent_definition），
--     在百万级日志量下会拖慢前端。冗余字段把按 Agent 切分降为单表 GROUP BY。
--   - v2 设计文档 §4.3.2 明确要求 mcp_call_log 增加 transport / circuit_state，本期一起补。
--
-- 关键设计：
--   1. 所有新列 nullable / 无默认值；旧行不需要回填即可读。
--   2. circuit_state 加 CHECK 约束保护，但允许 NULL（旧行 / 未捕捉到的情形）。
--   3. 索引覆盖"按 Agent + 时间"的高频查询；按 transport 切分是低频不单独建索引。
--
-- 回滚见 down-0064.sql（DROP 列 + 索引；不删任何行）。

-- ───────────────────────── llm_call_log ─────────────────────────
ALTER TABLE `llm_call_log` ADD COLUMN `agent_definition_id` TEXT REFERENCES `agent_definition`(`id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_llm_call_log_agent_def_created`
  ON `llm_call_log` (`agent_definition_id`, `created_at` DESC);
--> statement-breakpoint

-- ───────────────────────── tool_call_log ─────────────────────────
ALTER TABLE `tool_call_log` ADD COLUMN `agent_definition_id` TEXT REFERENCES `agent_definition`(`id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tool_call_log_agent_def_created`
  ON `tool_call_log` (`agent_definition_id`, `created_at` DESC);
--> statement-breakpoint

-- ───────────────────────── mcp_call_log ─────────────────────────
ALTER TABLE `mcp_call_log` ADD COLUMN `agent_definition_id` TEXT REFERENCES `agent_definition`(`id`);
--> statement-breakpoint
ALTER TABLE `mcp_call_log` ADD COLUMN `transport` TEXT;
--> statement-breakpoint
-- 注意：ALTER 加 CHECK 在 SQLite 上需要重建表，这里只用列默认+应用层约束；
-- 业务侧由 schema.ts 的 enum 校验兜底。
ALTER TABLE `mcp_call_log` ADD COLUMN `circuit_state` TEXT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_agent_def_created`
  ON `mcp_call_log` (`agent_definition_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_circuit_created`
  ON `mcp_call_log` (`circuit_state`, `created_at` DESC);
