-- 0080_quant_lineage — 量化研究产物 lineage 字段统一补齐
--
-- 背景（2026-06-09 量化工作台增强）：
--   1. 前端 4 个 tab（Factor / Discovery / Composer / Backtest）当前完全
--      看不到「这个因子/组合/回测是 Agent 生成还是用户手动建的」、
--      「来自哪个 workflow / 哪个 discovery_job」等溯源信息。
--   2. backend 侧虽然 `factor_definition.workflow_run_id` /
--      `discovery_job.workflow_run_id` 已存在，但 `rule_definition` /
--      `strategy_composition` / `backtest_run` 仍缺；`backtest_run.agentInstanceId`
--      虽有列但 BacktestJobService.submit() 一直传 NULL，等于没用。
--
-- 本迁移按统一 lineage 协议给所有研究产物表补：
--   - created_by     TEXT NOT NULL DEFAULT 'user'   -- 'user' | 'agent' | 'discovery_promote' | 'clone' | 'system'
--   - workflow_run_id TEXT                          -- 工作流上下文（NULL = IDE / REST 直接调用）
--   - agent_instance_id TEXT                        -- 发起调用的 agent_instance（NULL = 非 agent 路径）
--   - parent_id / composition_id 等表特定字段       -- 克隆 / 上游产物链
--
-- SQLite 限制：
--   - ALTER TABLE ADD COLUMN 不允许带 FK / UNIQUE / 复合 default；
--     因此 agent_instance_id / workflow_run_id 等不在 SQL 层声明 REFERENCES，
--     Drizzle schema 同样仅当普通 text 处理（查询时按需手动 join）。
--   - 每条 statement 之间必须用 drizzle 的 statement-breakpoint magic 注释分隔，
--     否则 migrator 只会执行第一条（2026-06-09 实测踩坑）。
--
-- 回滚：down-0080.sql 是 no-op（SQLite DROP COLUMN 代价高，且这些列默认值对老代码无害）。

-- ── factor_definition ───────────────────────────────────────────────────────
ALTER TABLE `factor_definition` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `agent_instance_id` TEXT;
--> statement-breakpoint
ALTER TABLE `factor_definition` ADD COLUMN `source_job_id` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_factor_definition_created_by` ON `factor_definition` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_factor_definition_agent_instance` ON `factor_definition` (`agent_instance_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_factor_definition_source_job` ON `factor_definition` (`source_job_id`);
--> statement-breakpoint

-- ── rule_definition ─────────────────────────────────────────────────────────
ALTER TABLE `rule_definition` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE `rule_definition` ADD COLUMN `workflow_run_id` TEXT;
--> statement-breakpoint
ALTER TABLE `rule_definition` ADD COLUMN `agent_instance_id` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rule_definition_created_by` ON `rule_definition` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rule_definition_workflow` ON `rule_definition` (`workflow_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_rule_definition_agent_instance` ON `rule_definition` (`agent_instance_id`);
--> statement-breakpoint

-- ── discovery_job ───────────────────────────────────────────────────────────
ALTER TABLE `discovery_job` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE `discovery_job` ADD COLUMN `agent_instance_id` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_discovery_job_created_by` ON `discovery_job` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_discovery_job_agent_instance` ON `discovery_job` (`agent_instance_id`);
--> statement-breakpoint

-- ── strategy_composition ────────────────────────────────────────────────────
ALTER TABLE `strategy_composition` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE `strategy_composition` ADD COLUMN `workflow_run_id` TEXT;
--> statement-breakpoint
ALTER TABLE `strategy_composition` ADD COLUMN `agent_instance_id` TEXT;
--> statement-breakpoint
ALTER TABLE `strategy_composition` ADD COLUMN `parent_composition_id` TEXT;
--> statement-breakpoint
ALTER TABLE `strategy_composition` ADD COLUMN `name` TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE `strategy_composition` ADD COLUMN `description` TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_composition_created_by` ON `strategy_composition` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_composition_workflow` ON `strategy_composition` (`workflow_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_composition_agent_instance` ON `strategy_composition` (`agent_instance_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_composition_parent` ON `strategy_composition` (`parent_composition_id`);
--> statement-breakpoint

-- ── backtest_run（事件驱动 BacktestJobService 使用的表） ─────────────────────
-- agentInstanceId 列在 0009/0010 初始 schema 就有，但被 BacktestJobService.submit 写 NULL；
-- 这里只补 lineage 元信息列，service 改造后会把这些列真正写入。
ALTER TABLE `backtest_run` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user';
--> statement-breakpoint
ALTER TABLE `backtest_run` ADD COLUMN `workflow_run_id` TEXT;
--> statement-breakpoint
ALTER TABLE `backtest_run` ADD COLUMN `composition_id` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backtest_run_created_by` ON `backtest_run` (`created_by`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backtest_run_workflow` ON `backtest_run` (`workflow_run_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backtest_run_composition` ON `backtest_run` (`composition_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_backtest_run_agent_instance` ON `backtest_run` (`agent_instance_id`);

