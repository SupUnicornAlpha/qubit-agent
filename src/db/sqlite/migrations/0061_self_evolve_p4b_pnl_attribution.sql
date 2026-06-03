-- Self-Evolving Agent P4b — PnL 归因（详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §P4b）
--
-- 在 P4a 路面（daily_mark_price / strategy_pnl_snapshot / fee_schedule）上跑车：
-- PnlAttributor worker 把策略层 PnL 进一步归因到 agent + skill 维度，让飞轮的
-- "skill 真实收益指标" 第一次有数据。
--
-- 改动总览：
--   1) 新表 agent_pnl_attribution：一次 workflow_run 的 PnL 归因明细
--      （一行 = (workflow_run, definition, as_of_date)）；含 skill_ids_json
--      与 per_skill_share 让 reader 不用再除。
--   2) agent_skill 补 3 字段：
--      - pnl_attribution_json：30 天滚动汇总（windowDays/pnlSum/winCount/loseCount/lastUpdatedAt）
--      - last_promoted_at：P5 SkillPromoter 留位（P4b 不写，避免每期都 alter 表）
--      - evolution_mode：'manual'|'auto'，default 'manual'（P6 / P9 用）
--   3) agent_skill_run 补 2 字段：
--      - pnl_delta：单次 skill 执行分到的 PnL
--      - attribution_confidence：归因置信度，v0 等权恒为 1.0；P4b+ Shapley 时小于 1
--
-- 设计取舍：
--   - 选 1：agent_pnl_attribution 一行只锚到 1 个 agent（definition）+ 1 个 workflow_run，
--          skill 多个走 skill_ids_json + per_skill_share；避免 N×K 行爆炸。
--   - 选 2：agent_skill_run.pnl_delta nullable —— 旧 run（P4b 之前的）不回填，
--          只对 P4b 之后产生 + 有 PnL 信号的 run 写值；reader 用 IS NOT NULL 过滤。
--   - 选 3：agent_skill.pnl_attribution_json 30 天滚动 by PnlAttributor 重算覆盖，不增量；
--          避免读时聚合 N 行 agent_pnl_attribution 的扇出。
--
-- 兼容性：1 张新表 + agent_skill / agent_skill_run alter 表（仅 ADD COLUMN，drizzle
-- 自动识别）。旧业务路径全部不动；P4b worker 默认 stopped，需要主动 cron 触发。
-- 回滚见 down-0061.sql（手写）。

-- ───────────────────────── agent_pnl_attribution ─────────────────────────
CREATE TABLE IF NOT EXISTS `agent_pnl_attribution` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT NOT NULL
    REFERENCES `workflow_run`(`id`) ON DELETE CASCADE,
  -- 归因到哪个 agent_definition；nullable 是因为 strategyRuntime → workflow_run
  -- 反查可能拿不到 agent（典型：纯量化 cron 触发的 fill 无 agent_instance）
  `definition_id` TEXT
    REFERENCES `agent_definition`(`id`) ON DELETE SET NULL,
  `strategy_runtime_id` TEXT NOT NULL
    REFERENCES `strategy_runtime`(`id`) ON DELETE CASCADE,
  -- ISO date 'YYYY-MM-DD'（按 market 本地交易日）
  `as_of_date` TEXT NOT NULL,
  -- 归因到该 (run, def, date) 的 PnL（已扣 fee）
  `pnl_attributed` REAL NOT NULL DEFAULT 0,
  -- 该 run 召回执行过的 skill_id 列表（JSON string[]）；可为空数组
  `skill_ids_json` TEXT NOT NULL DEFAULT '[]',
  -- pnl_attributed / max(1, len(skill_ids_json))；预算冗余字段给 reader
  `per_skill_share` REAL NOT NULL DEFAULT 0,
  -- 'equal_weight_v0' / 'time_decay_v1' / 'shapley_v2'
  `attribution_method` TEXT NOT NULL DEFAULT 'equal_weight_v0',
  -- v0 恒为 1.0；Shapley 时小于 1
  `attribution_confidence` REAL NOT NULL DEFAULT 1.0,
  -- 自由附加：is_anomaly / partial_data_flag / runtime_market / symbols_json 等
  `metadata_json` TEXT NOT NULL DEFAULT '{}',
  `computed_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

-- 唯一键：同一 (workflow_run, definition, date) 一行；worker 重跑走 upsert
-- definition_id 可空，sqlite 的 UNIQUE 允许多行 NULL —— P4b 不打 NULL（pnl 没 agent 就不归因）
CREATE UNIQUE INDEX IF NOT EXISTS `idx_agent_pnl_attr_unique`
  ON `agent_pnl_attribution` (`workflow_run_id`, `definition_id`, `as_of_date`);
--> statement-breakpoint
-- runtime + 日期范围扫（策略级回溯）
CREATE INDEX IF NOT EXISTS `idx_agent_pnl_attr_runtime_date`
  ON `agent_pnl_attribution` (`strategy_runtime_id`, `as_of_date`);
--> statement-breakpoint
-- 按 agent 维度看时间序（前端 PnL Attribution sub-tab）
CREATE INDEX IF NOT EXISTS `idx_agent_pnl_attr_def_date`
  ON `agent_pnl_attribution` (`definition_id`, `as_of_date`);
--> statement-breakpoint

-- ───────────────────────── agent_skill 补字段 ─────────────────────────
-- pnl_attribution_json: 30 天滚动汇总，PnlAttributor 每次跑都覆盖。
-- 结构例：{"windowDays":30,"pnlSum":1234.5,"winCount":12,"loseCount":3,"lastUpdatedAt":"2026-06-03T..."}
ALTER TABLE `agent_skill` ADD COLUMN `pnl_attribution_json` TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint

-- last_promoted_at: P5 SkillPromoter 用，P4b 先建空位避免每期 alter
ALTER TABLE `agent_skill` ADD COLUMN `last_promoted_at` TEXT;
--> statement-breakpoint

-- evolution_mode: 'manual'|'auto'，P6/P9 用
ALTER TABLE `agent_skill` ADD COLUMN `evolution_mode` TEXT NOT NULL DEFAULT 'manual';
--> statement-breakpoint

-- ───────────────────────── agent_skill_run 补字段 ─────────────────────────
-- pnl_delta: 单次 skill 执行分到的 PnL（v0 等权 PnL/K）；nullable
ALTER TABLE `agent_skill_run` ADD COLUMN `pnl_delta` REAL;
--> statement-breakpoint

-- attribution_confidence: 归因置信度；v0 恒为 1.0；Shapley 时小于 1
ALTER TABLE `agent_skill_run` ADD COLUMN `attribution_confidence` REAL;
