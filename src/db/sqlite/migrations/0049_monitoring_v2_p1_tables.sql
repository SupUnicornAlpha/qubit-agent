-- 监控 V2 P1 — 新表 + tool_call_log 升级（详见 docs/MONITORING_V2_DESIGN.md §4.3 / §6）
--
-- 改动总览：
--   1) 新表 llm_call_log：LLM 调用粒度落库（provider/model/token/latency/cost），
--      reason 节点的 token 之前只写在 agent_step.token_count 一个聚合数；
--      新表让我们可以做按 provider 跨工作流的统计与 cost 估算。
--   2) 新表 mcp_server_health：MCP dispatcher 熔断状态持久化（替代纯内存 Map），
--      让重启后能恢复熔断；同时让前端能看到「现在 datadog server 处于 open 状态」。
--   3) 新表 skill_recall_log：reason 节点候选 skill 的「召回 vs 显式选用」对比；
--      P0 阶段我们已通过 agent_skill_run 抓显式执行，此表抓召回侧。
--   4) tool_call_log 升级：新增 workflow_run_id / trace_id / retry_count 三列。
--      旧逻辑只能通过 agent_step_id 间接 join 到 workflow_run_id；新列让监控查询
--      不再依赖 join，且能区分「同 trace 内的重试」与「不同请求」。
--
-- 兼容性：所有新列都 nullable / default，老行可读、不强制重写。

-- ───────────────────────── llm_call_log ─────────────────────────
CREATE TABLE IF NOT EXISTS `llm_call_log` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT NOT NULL REFERENCES `workflow_run`(`id`),
  `agent_step_id` TEXT REFERENCES `agent_step`(`id`),
  `provider` TEXT NOT NULL,
  `model` TEXT NOT NULL,
  `prompt_tokens` INTEGER,
  `completion_tokens` INTEGER,
  `total_tokens` INTEGER,
  `latency_ms` INTEGER NOT NULL,
  `status` TEXT NOT NULL,          -- 'success' | 'error' | 'timeout' | 'fallback'
  `error_message` TEXT,
  `cost_usd` REAL,
  `request_meta_json` TEXT NOT NULL DEFAULT '{}', -- 已剥密的元信息（system/user prompt 长度等），不存原文
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_llm_call_log_workflow_created`
  ON `llm_call_log` (`workflow_run_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_llm_call_log_provider_model_created`
  ON `llm_call_log` (`provider`, `model`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_llm_call_log_status_created`
  ON `llm_call_log` (`status`, `created_at` DESC);
--> statement-breakpoint

-- ───────────────────────── mcp_server_health ─────────────────────────
-- 注意：server_name 唯一（一个 server 只一行健康状态）；circuit_state 枚举与
-- src/runtime/external-call/policy.ts 内部状态一致（closed/open/half_open）。
CREATE TABLE IF NOT EXISTS `mcp_server_health` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `server_name` TEXT NOT NULL UNIQUE,
  `circuit_state` TEXT NOT NULL DEFAULT 'closed', -- 'closed' | 'open' | 'half_open'
  `failure_count` INTEGER NOT NULL DEFAULT 0,
  `success_count` INTEGER NOT NULL DEFAULT 0,
  `last_failure_at` TEXT,
  `last_success_at` TEXT,
  `opened_at` TEXT,           -- 熔断器变 open 时的时间
  `last_check_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `cooldown_ms` INTEGER NOT NULL DEFAULT 30000,
  `last_error_message` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_mcp_server_health_state`
  ON `mcp_server_health` (`circuit_state`, `updated_at` DESC);
--> statement-breakpoint

-- ───────────────────────── skill_recall_log ─────────────────────────
-- 「reason 节点检索到 N 个候选 skill」就写一行；executed=true 表示该 skill 真的被采纳。
-- 用于回答「召回 10 个 skill 但只用了 1 个，召回质量怎样」。
CREATE TABLE IF NOT EXISTS `skill_recall_log` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `workflow_run_id` TEXT NOT NULL REFERENCES `workflow_run`(`id`),
  `agent_step_id` TEXT REFERENCES `agent_step`(`id`),
  `definition_id` TEXT REFERENCES `agent_definition`(`id`),
  `skill_id` TEXT NOT NULL REFERENCES `agent_skill`(`id`),
  `recall_rank` INTEGER,            -- 0-based 排名；null=无候选排序
  `score` REAL,                     -- 检索分（embedding 距离 / BM25 等），可选
  `executed` INTEGER NOT NULL DEFAULT 0, -- 1=真的被采用，0=只是候选
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_skill_recall_log_workflow_created`
  ON `skill_recall_log` (`workflow_run_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_recall_log_def_created`
  ON `skill_recall_log` (`definition_id`, `created_at` DESC);
--> statement-breakpoint

-- ───────────────────────── tool_call_log 升级 ─────────────────────────
-- 现状（schema.ts:764-779）：只通过 agent_step_id 间接关联 workflow_run_id；
-- 监控页要按 workflow 直接查工具调用会被迫两次 join，性能与可读性都差。
-- v2 起新写入端直接填 workflow_run_id；老行保持 NULL，前端 fallback 走 join。
ALTER TABLE `tool_call_log` ADD COLUMN `workflow_run_id` TEXT REFERENCES `workflow_run`(`id`);
--> statement-breakpoint
ALTER TABLE `tool_call_log` ADD COLUMN `trace_id` TEXT;
--> statement-breakpoint
ALTER TABLE `tool_call_log` ADD COLUMN `retry_count` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tool_call_log_workflow_created`
  ON `tool_call_log` (`workflow_run_id`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tool_call_log_kind_status_created`
  ON `tool_call_log` (`tool_kind`, `status`, `created_at` DESC);
--> statement-breakpoint

-- ───────────────────────── mcp_call_log 升级 ─────────────────────────
-- workflow_run_id 已存在；补 retry_count / trace_id（与 tool_call_log 对齐，便于跨表 union）。
ALTER TABLE `mcp_call_log` ADD COLUMN `trace_id` TEXT;
--> statement-breakpoint
ALTER TABLE `mcp_call_log` ADD COLUMN `retry_count` INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_server_created`
  ON `mcp_call_log` (`server_name`, `created_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mcp_call_log_workflow_created`
  ON `mcp_call_log` (`workflow_run_id`, `created_at` DESC);
