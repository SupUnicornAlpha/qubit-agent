-- 0083_drop_langgraph_checkpoint.sql
--
-- 执行路径收敛阶段 5 清理（详见 docs plan「A2A 唯一总线 + 移除 LangGraph + 自研 checkpoint」）。
--
-- 背景：
--   * LangGraph 框架已在阶段 1~4 整体移除，ReAct 循环抽成纯函数 while 循环
--     （src/runtime/react/run-react-loop.ts），A2A 成为唯一 internal agent 总线。
--   * checkpoint 改用自研 `agent_checkpoint_snapshot`（0036 起即存在，FK 直挂
--     workflow_run.id / agent_instance.id），原 LangGraph 的两张表彻底无人读写：
--       - `langgraph_checkpoint`（0036 建）
--       - `langgraph_checkpoint_write`（0036 建）
--     全仓零 source import；周期 GC（checkpoint-gc.ts）与 hard-delete 的显式清理
--     均已删除。
--   * workflow_run 上 3 个仅服务 LangGraph thread 的死字段同步 drop：
--       - `langgraph_thread_id`（thread_id 寻址）
--       - `last_checkpoint_id` / `last_checkpoint_at`（checkpoint 游标）
--     这三列在 schema.ts / runtime 全文 0 读 0 写（除 schema 定义本身）。
--
-- 兼容性影响：
--   * 旧库升级后表与数据丢失；自研 snapshot 不依赖它们，in-flight 恢复走
--     agent_checkpoint_snapshot，无功能回退。
--   * 历史 executionPath='graph' 的 awaiting_approval workflow 由 native 恒返回
--     a2a 走重放路径，不依赖这些列。
--
-- 不可回滚：down 只能 CREATE TABLE + ADD COLUMN 重建空壳，数据无法恢复。

DROP TABLE IF EXISTS `langgraph_checkpoint_write`;
--> statement-breakpoint
DROP TABLE IF EXISTS `langgraph_checkpoint`;
--> statement-breakpoint
ALTER TABLE `workflow_run` DROP COLUMN `langgraph_thread_id`;
--> statement-breakpoint
ALTER TABLE `workflow_run` DROP COLUMN `last_checkpoint_id`;
--> statement-breakpoint
ALTER TABLE `workflow_run` DROP COLUMN `last_checkpoint_at`;
