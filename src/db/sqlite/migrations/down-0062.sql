-- Down migration for 0062_self_evolve_p5_skill_promoter.sql
-- 危险：会删 skill_promotion_run 全表数据；agent_skill.promotion_* 字段虽然
-- DROP COLUMN（SQLite 3.35+ 支持），但 pending_review state 的 skill 不会被回退。
-- 部署时必须先把 pending_review skill 全部清掉/approve，再跑 down。

DROP INDEX IF EXISTS `idx_agent_skill_promotion_score`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agent_skill_promotion_run`;
--> statement-breakpoint

ALTER TABLE `agent_skill` DROP COLUMN `promotion_review_at`;
--> statement-breakpoint
ALTER TABLE `agent_skill` DROP COLUMN `promotion_score`;
--> statement-breakpoint
ALTER TABLE `agent_skill` DROP COLUMN `promotion_run_id`;
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_skill_promotion_run_status`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_skill_promotion_run_project`;
--> statement-breakpoint
DROP TABLE IF EXISTS `skill_promotion_run`;
