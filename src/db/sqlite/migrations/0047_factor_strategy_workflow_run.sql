-- M8 follow-up: 给 factor_definition / strategy_version 加 workflow_run_id
--
-- 背景：研究产出侧栏 (frontend/src/components/team/AgentGenerated*Block.tsx)
-- 之前只能按 createdAt >= workflowStartedAt 做时间近似过滤，无法严格定位
-- 「本工作流」生成的因子 / 策略，且历史上曾经把 manual / 旧 workflow 的产物
-- 误显示给用户。本迁移给两张表加 nullable workflow_run_id（NULL 保留给
-- IDE / API / 历史数据），后续 listFactors / listStrategyVersions 走严格匹配。
--
-- 索引选择 (project_id, workflow_run_id) 是为了让 "拉本工作流的因子"
-- 这条主查询命中 covering index；query 形态见 factor.routes.ts。

ALTER TABLE `factor_definition` ADD COLUMN `workflow_run_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_factor_definition_project_workflow`
  ON `factor_definition` (`project_id`, `workflow_run_id`);
--> statement-breakpoint

ALTER TABLE `strategy_version` ADD COLUMN `workflow_run_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_version_workflow`
  ON `strategy_version` (`workflow_run_id`);
