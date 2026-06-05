-- 修复 agent_runtime_metric 唯一索引「应是 UNIQUE 却是普通 INDEX」的历史漏洞
--
-- 故障表现：
--   前端「监控 / Agent / 持久化指标 / 聚合过去24h并刷新」按钮总是 HTTP 500：
--     {"error":"ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"}
--   导致 P50 / P95 工具延迟图一直空白；agent_runtime_metric 表自 0048 上线后一行都没成功写入。
--
-- 根因：
--   - 0012_observability_metrics.sql 创建过普通索引：
--       CREATE INDEX IF NOT EXISTS idx_agent_runtime_metric_def_window ON ...
--   - 0048_agent_runtime_metric_breakdown.sql 想升级为 UNIQUE：
--       CREATE UNIQUE INDEX IF NOT EXISTS `idx_agent_runtime_metric_def_window` ON ...
--     但因为同名索引已存在，IF NOT EXISTS 让 0048 静默跳过，索引仍然是非 UNIQUE。
--   - aggregateAgentRuntimeMetrics 用 drizzle `.onConflictDoUpdate(target: [def, ws, we])`，
--     SQLite 在 target 列上找不到 UNIQUE 约束，整条 INSERT 直接报错回滚。
--
-- 修复策略：
--   1) 防御性 dedupe（同 0048 套路）：兼容新装数据库在 0012→0076 之间可能积累的重复行；
--      老数据库（包括用户当前 DB）表为空时此 DELETE 是 no-op。
--   2) DROP 现有非 UNIQUE 同名索引，再以同名重建 UNIQUE INDEX。
--      保持索引名不变，避免 schema/查询计划另起新索引。

DELETE FROM `agent_runtime_metric`
WHERE `id` NOT IN (
  SELECT `id`
  FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `definition_id`, `window_start`, `window_end`
        ORDER BY `created_at` DESC, `id` DESC
      ) AS `rn`
    FROM `agent_runtime_metric`
  )
  WHERE `rn` = 1
);
--> statement-breakpoint

DROP INDEX IF EXISTS `idx_agent_runtime_metric_def_window`;
--> statement-breakpoint

CREATE UNIQUE INDEX `idx_agent_runtime_metric_def_window`
  ON `agent_runtime_metric` (`definition_id`, `window_start`, `window_end`);
