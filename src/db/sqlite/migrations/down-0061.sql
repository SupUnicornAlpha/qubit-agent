-- Rollback for 0061_self_evolve_p4b_pnl_attribution.sql
-- 注意 sqlite 不支持 DROP COLUMN（除非 3.35+，bun:sqlite 已支持），仍然按全量删表
-- 重建作为安全降级（更稳）。本文件作为手动调试 / dev wipe 之用，不在正常迁移链。

DROP INDEX IF EXISTS `idx_agent_pnl_attr_def_date`;
DROP INDEX IF EXISTS `idx_agent_pnl_attr_runtime_date`;
DROP INDEX IF EXISTS `idx_agent_pnl_attr_unique`;
DROP TABLE IF EXISTS `agent_pnl_attribution`;

-- agent_skill / agent_skill_run alter 字段回滚（bun sqlite >= 3.35）：
ALTER TABLE `agent_skill_run` DROP COLUMN `attribution_confidence`;
ALTER TABLE `agent_skill_run` DROP COLUMN `pnl_delta`;
ALTER TABLE `agent_skill` DROP COLUMN `evolution_mode`;
ALTER TABLE `agent_skill` DROP COLUMN `last_promoted_at`;
ALTER TABLE `agent_skill` DROP COLUMN `pnl_attribution_json`;
