-- agent_runtime_metric 升级：支持 Agent 维度下钻聚合（详见 docs/MONITORING_V2_DESIGN.md §4.1.3）
--
-- 改动：
--   1) 新增 breakdown_json 列：按工具/MCP/Skill/失败原因维度的拆分聚合（JSON object）。
--      结构示例：
--        {
--          "byTool":     { "place_order": { "count": 12, "error": 1, "avgLatencyMs": 320 }, ... },
--          "byMcp":      { "datadog.search_logs": { "count": 3, "error": 0, "avgLatencyMs": 540 } },
--          "bySkill":    { "factor-stat": { "count": 6, "fail": 1 } },
--          "errorTopN":  [ { "message": "...", "count": 3 }, ... ]
--        }
--      读取端容错：旧行默认 '{}'，前端 JSON.parse 失败时降级为空 breakdown。
--
--   2) 唯一索引 (definition_id, window_start, window_end)：
--      之前 aggregateAgentRuntimeMetrics 每次调用都 INSERT 一行 —— 重复聚合相同窗口会
--      产生大量历史副本，前端 listAgentQuality 取「最新一条」时性能与正确性都差。
--      v2 起改为 INSERT ON CONFLICT DO UPDATE（UPSERT），需要先建唯一索引。
--      迁移路径：先 dedupe 旧重复行（每组只保留 created_at 最新者），再加索引。
--
-- SQLite 3.25+ 支持 ROW_NUMBER OVER；bun:sqlite 内置 3.45 满足。

ALTER TABLE `agent_runtime_metric`
  ADD COLUMN `breakdown_json` TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint

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

CREATE UNIQUE INDEX IF NOT EXISTS `idx_agent_runtime_metric_def_window`
  ON `agent_runtime_metric` (`definition_id`, `window_start`, `window_end`);
