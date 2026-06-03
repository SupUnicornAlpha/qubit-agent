-- Self-Evolving Agent P8 — AutoInstaller propose 模式（详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §6.6）
--
-- P7 已经把"agent 想用某工具但没有"的隐性信号收敛到 `tool_gap_log`。本期把它和已有的
-- `mcp_catalog` / `mcp_catalog_item`（builtin / registry 爬来的 MCP 工具目录）路由起来：
-- 每条 open gap 出一个候选 proposal 入审批队列，用户在 MemoryTab > Tool Gaps 一键 approve/reject。
--
-- 关键设计：
--   1. 一个 gap 在 status=pending_review 时只有 1 个 proposal —— 用 partial-unique-on-pending
--      索引保证；avoid 重跑 watcher 制造重复 proposal。
--   2. proposal 状态机：pending_review → approved | rejected | no_candidate（mat 不到）。
--      approved 不会真去调 install_mcp_from_catalog —— 那是后续 P9 auto 模式 / 现有
--      `/tools/mcp/catalog/:slug/install` 端点的事。P8 propose 模式只到 approved 状态，
--      由用户自己点 install 按钮（同复用 mcp catalog 已有装机器）。
--   3. proposal 不打 catalog FK：mcp_catalog 或 mcp_catalog_item 可能被删 / 改 slug；
--      proposal 只记 `target_kind` + `target_slug` + 一份不可变 payload_json snapshot 保留。
--   4. `auto_installer_run` 仿 `tool_gap_run` 模式，每次跑批一行，给前端展示 + 故障复盘。
--
-- 回滚见 down-0065.sql。

-- ───────────────────────── auto_install_proposal ─────────────────────────
CREATE TABLE IF NOT EXISTS `auto_install_proposal` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL
    REFERENCES `project`(`id`) ON DELETE CASCADE,
  -- 不打 FK：保留"gap 被删 / 重新生成"语义；matcher 直接拿 gap_log_id 关联
  `gap_log_id` TEXT NOT NULL,

  -- 'install_mcp_catalog'  → 从 mcp_catalog 装一个 builtin 服务器
  -- 'install_mcp_external' → 从 mcp_catalog_item（registry 来源）装一个外部服务器
  -- 'no_candidate'         → 没匹配到任何 catalog 项；记录给前端展示"需要人工补 catalog"
  `proposal_kind` TEXT NOT NULL,

  -- 'low' / 'medium' / 'high'；从 catalog.riskLevel 透传，给前端做"高危需 actor=admin"
  `safety_level` TEXT NOT NULL DEFAULT 'medium',

  -- 0~1 综合得分（匹配置信度）；只有 best 候选写 proposal，top-3 全量在 actions_json
  `match_score` REAL NOT NULL DEFAULT 0,

  -- 候选目标：
  --   target_kind='mcp_catalog'           → target_id 指 mcp_catalog.id      / target_slug=mcp_catalog.slug
  --   target_kind='mcp_catalog_item'      → target_id 指 mcp_catalog_item.id / target_slug=item.slug
  --   target_kind=NULL（no_candidate）    → target_id / target_slug 都为空
  -- 不打 FK：上游可能软删；保留快照即可。
  `target_kind` TEXT,
  `target_id` TEXT,
  `target_slug` TEXT,

  -- 不可变 payload 快照：审批时看到的完整候选信息（name / description / risk / transport / tool_name）
  -- 防止 catalog 后续被改后用户审批时看到的 ≠ propose 时实际匹配到的
  `payload_json` TEXT NOT NULL DEFAULT '{}',

  -- top-3 候选含 score / ruleHits（前端展示"为什么是它"）；最多 3 条
  `candidates_json` TEXT NOT NULL DEFAULT '[]',

  -- 'pending_review' / 'approved' / 'rejected' / 'no_candidate'
  `state` TEXT NOT NULL DEFAULT 'pending_review',
  `state_at` TEXT,
  `state_by` TEXT,
  `state_reason` TEXT,

  -- propose 时关联的跑批
  `proposer_run_id` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK (`proposal_kind` IN ('install_mcp_catalog', 'install_mcp_external', 'no_candidate')),
  CHECK (`safety_level` IN ('low', 'medium', 'high')),
  CHECK (`state` IN ('pending_review', 'approved', 'rejected', 'no_candidate'))
);
--> statement-breakpoint

-- 列表：按 project + state 展示
CREATE INDEX IF NOT EXISTS `idx_auto_install_proposal_project_state`
  ON `auto_install_proposal` (`project_id`, `state`, `created_at`);
--> statement-breakpoint

-- 同一 gap 同时只能有 1 个 pending_review proposal（防 watcher 重跑写重复）
CREATE UNIQUE INDEX IF NOT EXISTS `idx_auto_install_proposal_gap_pending`
  ON `auto_install_proposal` (`gap_log_id`)
  WHERE `state` = 'pending_review';
--> statement-breakpoint

-- 反查：某 gap 的所有历史 proposal（含 rejected / approved）
CREATE INDEX IF NOT EXISTS `idx_auto_install_proposal_gap`
  ON `auto_install_proposal` (`gap_log_id`, `created_at`);
--> statement-breakpoint

-- ───────────────────────── auto_installer_run ─────────────────────────
CREATE TABLE IF NOT EXISTS `auto_installer_run` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL
    REFERENCES `project`(`id`) ON DELETE CASCADE,
  -- 'running' / 'completed' / 'failed'
  `status` TEXT NOT NULL DEFAULT 'running',
  `triggered_by` TEXT NOT NULL DEFAULT 'cron',

  `gaps_scanned` INTEGER NOT NULL DEFAULT 0,
  `proposals_created` INTEGER NOT NULL DEFAULT 0,
  `proposals_skipped_existing` INTEGER NOT NULL DEFAULT 0,
  `proposals_no_candidate` INTEGER NOT NULL DEFAULT 0,

  `actions_json` TEXT NOT NULL DEFAULT '[]',
  `elapsed_ms` INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT,
  `started_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_auto_installer_run_project`
  ON `auto_installer_run` (`project_id`, `started_at`);
