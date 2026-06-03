-- Rollback Self-Evolving Agent P7（详见 0063_self_evolve_p7_tool_gap.sql）

DROP INDEX IF EXISTS `idx_tool_gap_run_project`;
DROP TABLE IF EXISTS `tool_gap_run`;

DROP INDEX IF EXISTS `idx_tool_gap_log_kind`;
DROP INDEX IF EXISTS `idx_tool_gap_log_dedup_open`;
DROP INDEX IF EXISTS `idx_tool_gap_log_project_status`;
DROP TABLE IF EXISTS `tool_gap_log`;
