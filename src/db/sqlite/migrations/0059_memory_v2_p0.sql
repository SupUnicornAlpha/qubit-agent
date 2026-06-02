-- Memory V2 P0 — experience 统一经验体（详见 docs/MEMORY_V2_DESIGN.md §4）
--
-- 改动总览：
--   1) 新表 experience：把旧 3 张记忆表（session/midterm/longterm）+ agent_skill
--      抽象成"经验体"。本期仅落表 + 类型 + Store/Bus 边界，业务路径不切换（旧
--      表照常工作），P1 起由 Writer/Extractor/Reflector/Janitor/Recall 5 个 pipe
--      真正驱动读写。
--   2) 新表 experience_link：取代死表 memory_link，记录 derive_from / summarize_to
--      / evidence_of / conflicts_with / supersedes 关系，由 Extractor/Reflector
--      在 P1 真正写入；Recall 的 LinkExpander 用它做 1-跳邻居扩展。
--   3) 新表 reflection_run：失败必反思 + 预算 + 签名去重的留痕；status 包含
--      3 类 skipped_* 让我们能区分"被预算挡掉 vs 被去重挡掉 vs 抽样未中"。
--   4) 新表 experience_op_log：experience 全生命周期审计（create/update/recall/
--      execute/decay/archive/promote），是 qualityScore 重算的事实依据。
--
-- 兼容性：4 张表均为新增；旧 session_memory / midterm_memory / longterm_memory /
-- memory_link / agent_skill 不动；reason 节点 P0 内不切走，0 风险。回滚见
-- down-0059.sql（手写 DROP）。
--
-- 设计取舍（用户已对齐）：
--   - 选 1：物理新表（非 view），一次性迁移、查询简洁。
--   - 选 2：失败必反思 + 24h failure_signature 去重 + 每 project 每日 token 预算。
--   - 选 3：P1 仅关键词 + JSON path 召回；embedding_ref 字段 P1 全 null。
--   - 选 4：semantic 共享（visibility=project_shared，definitionId 可空）；
--          reflective 隔离（visibility=agent_private，definitionId 必填）。

-- ───────────────────────── experience ─────────────────────────
CREATE TABLE IF NOT EXISTS `experience` (
  `id` TEXT PRIMARY KEY NOT NULL,
  -- episodic | semantic | procedural | reflective | identity
  `kind` TEXT NOT NULL,
  -- 取代旧 memoryType 硬编码 enum，自由 string
  `sub_kind` TEXT NOT NULL DEFAULT '',
  -- org | workspace | project | strategy | workflow
  `scope` TEXT NOT NULL,
  `scope_id` TEXT NOT NULL,
  -- reflective 必填；semantic 可空（表示项目共有）
  `definition_id` TEXT REFERENCES `agent_definition`(`id`) ON DELETE SET NULL,
  -- agent_private | role_shared | project_shared
  `visibility` TEXT NOT NULL DEFAULT 'project_shared',
  -- {summary, body, ...} 大字段也放这；不再生成 markdown 镜像文件
  `content_json` TEXT NOT NULL,
  -- 自由 string[]，用于过滤检索
  `tags_json` TEXT NOT NULL DEFAULT '[]',
  -- 0~1；Janitor nightly 重算
  `quality_score` REAL NOT NULL DEFAULT 0.5,
  `use_count` INTEGER NOT NULL DEFAULT 0,
  `success_count` INTEGER NOT NULL DEFAULT 0,
  `fail_count` INTEGER NOT NULL DEFAULT 0,
  -- 软归档触发时间；null = 永不
  `decay_at` TEXT,
  `valid_from` TEXT NOT NULL,
  -- 被新版本取代时填，软删
  `valid_to` TEXT,
  -- evolve / consolidate 谱系
  `parent_id` TEXT,
  `source_run_id` TEXT REFERENCES `workflow_run`(`id`) ON DELETE SET NULL,
  -- P2 接 embedding 时回填；P1 全 null
  `embedding_ref` TEXT,
  `pinned` INTEGER NOT NULL DEFAULT 0,
  `metadata_json` TEXT NOT NULL DEFAULT '{}',
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_experience_scope_kind_quality`
  ON `experience` (`scope`, `scope_id`, `kind`, `quality_score`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_def_kind_validfrom`
  ON `experience` (`definition_id`, `kind`, `valid_from`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_kind_subkind`
  ON `experience` (`kind`, `sub_kind`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_decay`
  ON `experience` (`decay_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_parent`
  ON `experience` (`parent_id`);
--> statement-breakpoint

-- ───────────────────────── experience_link ─────────────────────────
CREATE TABLE IF NOT EXISTS `experience_link` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `from_id` TEXT NOT NULL REFERENCES `experience`(`id`) ON DELETE CASCADE,
  `to_id` TEXT NOT NULL REFERENCES `experience`(`id`) ON DELETE CASCADE,
  -- derive_from | summarize_to | evidence_of | conflicts_with | supersedes
  `relation` TEXT NOT NULL,
  `weight` REAL NOT NULL DEFAULT 1.0,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_experience_link_from_rel`
  ON `experience_link` (`from_id`, `relation`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_link_to_rel`
  ON `experience_link` (`to_id`, `relation`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_experience_link_unique`
  ON `experience_link` (`from_id`, `to_id`, `relation`);
--> statement-breakpoint

-- ───────────────────────── reflection_run ─────────────────────────
CREATE TABLE IF NOT EXISTS `reflection_run` (
  `id` TEXT PRIMARY KEY NOT NULL,
  -- workflow_completed | workflow_failed | daily | manual
  `scope` TEXT NOT NULL,
  -- workflow_* 时为 workflowRunId
  `subject_run_id` TEXT REFERENCES `workflow_run`(`id`) ON DELETE SET NULL,
  -- 仅 workflow_failed 有；用于 24h 去重
  `failure_signature` TEXT,
  -- 反思产物归属的 agent（隔离写入）
  `definition_id` TEXT REFERENCES `agent_definition`(`id`) ON DELETE SET NULL,
  -- running | completed | skipped_dedup | skipped_budget | sampled_out | failed
  `status` TEXT NOT NULL,
  `budget_tokens_used` INTEGER NOT NULL DEFAULT 0,
  `produced_experience_ids_json` TEXT NOT NULL DEFAULT '[]',
  `error_message` TEXT,
  `started_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_reflection_run_signature`
  ON `reflection_run` (`failure_signature`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_reflection_run_status_started`
  ON `reflection_run` (`status`, `started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_reflection_run_subject`
  ON `reflection_run` (`subject_run_id`);
--> statement-breakpoint

-- ───────────────────────── experience_op_log ─────────────────────────
CREATE TABLE IF NOT EXISTS `experience_op_log` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `experience_id` TEXT NOT NULL REFERENCES `experience`(`id`) ON DELETE CASCADE,
  -- create | update | recall | execute | decay | archive | promote
  `op` TEXT NOT NULL,
  -- recall / execute 时填
  `workflow_run_id` TEXT REFERENCES `workflow_run`(`id`) ON DELETE SET NULL,
  -- execute 时填，驱动 qualityScore
  `outcome` TEXT,                          -- 'success' | 'fail' | 'partial' | 'unknown'
  -- 'extractor' | 'reflector' | 'reason' | 'janitor' | 'user' 等
  `actor` TEXT NOT NULL DEFAULT 'system',
  `metadata_json` TEXT NOT NULL DEFAULT '{}',
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_experience_op_log_exp_created`
  ON `experience_op_log` (`experience_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_op_log_workflow_op`
  ON `experience_op_log` (`workflow_run_id`, `op`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_experience_op_log_op_created`
  ON `experience_op_log` (`op`, `created_at`);
