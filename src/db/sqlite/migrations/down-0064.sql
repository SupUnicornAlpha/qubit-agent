-- Rollback 监控 V3 P0（详见 0064_monitoring_v3_timeseries.sql）
--
-- SQLite 3.35+ 才支持 ALTER TABLE DROP COLUMN，本仓 bun:sqlite ≥ 3.45 OK。
-- 索引在列存在时建立，必须先 DROP INDEX 再 DROP COLUMN，否则 SQLite 会报
-- "no such column: agent_definition_id" 错误。

DROP INDEX IF EXISTS `idx_mcp_call_log_circuit_created`;
DROP INDEX IF EXISTS `idx_mcp_call_log_agent_def_created`;
ALTER TABLE `mcp_call_log` DROP COLUMN `circuit_state`;
ALTER TABLE `mcp_call_log` DROP COLUMN `transport`;
ALTER TABLE `mcp_call_log` DROP COLUMN `agent_definition_id`;

DROP INDEX IF EXISTS `idx_tool_call_log_agent_def_created`;
ALTER TABLE `tool_call_log` DROP COLUMN `agent_definition_id`;

DROP INDEX IF EXISTS `idx_llm_call_log_agent_def_created`;
ALTER TABLE `llm_call_log` DROP COLUMN `agent_definition_id`;
