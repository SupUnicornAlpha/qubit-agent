-- P0-E：drop `workflow_run.signal_fusion_id`
--
-- 背景：列于 0004_v2_trading_agent.sql 加入，本意是让 workflow_run 直接指向最终融合产物。
-- 但实际链路（msa/signal-fusion → signal_fusion_result）从未回写过这个字段，
-- runtime 全文搜索除 schema.ts:70 之外 0 caller。
-- 详见 docs (本轮架构盘点 P0-E)。
--
-- 注：`research_scenario_id` 虽同样 0 caller，但 FACTOR_RULE_STRATEGY_DESIGN.md 仍把它
-- 列为"研究场景"未来落地的承接字段；保留 column 等待真正接通 scenario 路由（见
-- 同文档 §10.3）。

ALTER TABLE `workflow_run` DROP COLUMN `signal_fusion_id`;
