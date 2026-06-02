-- 回滚脚本：手动执行（drizzle 自身不支持自动 down）。
-- 配套 0059_memory_v2_p0.sql。
--
-- 注意：FK CASCADE 让 experience_link / experience_op_log 跟着 experience 一起删；
-- 但作为防御，仍按依赖反序 DROP。

DROP INDEX IF EXISTS `idx_experience_op_log_op_created`;
DROP INDEX IF EXISTS `idx_experience_op_log_workflow_op`;
DROP INDEX IF EXISTS `idx_experience_op_log_exp_created`;
DROP TABLE IF EXISTS `experience_op_log`;

DROP INDEX IF EXISTS `idx_reflection_run_subject`;
DROP INDEX IF EXISTS `idx_reflection_run_status_started`;
DROP INDEX IF EXISTS `idx_reflection_run_signature`;
DROP TABLE IF EXISTS `reflection_run`;

DROP INDEX IF EXISTS `idx_experience_link_unique`;
DROP INDEX IF EXISTS `idx_experience_link_to_rel`;
DROP INDEX IF EXISTS `idx_experience_link_from_rel`;
DROP TABLE IF EXISTS `experience_link`;

DROP INDEX IF EXISTS `idx_experience_parent`;
DROP INDEX IF EXISTS `idx_experience_decay`;
DROP INDEX IF EXISTS `idx_experience_kind_subkind`;
DROP INDEX IF EXISTS `idx_experience_def_kind_validfrom`;
DROP INDEX IF EXISTS `idx_experience_scope_kind_quality`;
DROP TABLE IF EXISTS `experience`;
