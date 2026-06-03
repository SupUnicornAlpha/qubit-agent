-- Self-Evolving Agent P7 — ToolGapWatcher（详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §P7）
--
-- 目的：把"agent 想用某个工具但找不到 / 失败 / 不懂用"的隐性信号集中物化，
-- 给 P8 AutoInstaller propose 模式提供候选输入。三路来源：
--   1) ToolGapWatcher worker 从 tool_call_log 扫
--      - errorMessage 命中 unknown/not found/no such tool → detection_kind='unknown_tool'
--      - 同 toolName 24h 内 ≥ 3 次 error → detection_kind='repeated_fail'
--   2) ToolGapWatcher 扫 experience(reflective) 正文，正则提"缺/没有/需要……工具 X"
--      → detection_kind='reflective_mention'
--   3) agent 主动调 builtin `tool.report_gap` → detection_kind='explicit_report'
--   4) 用户在 MemoryTab > Tool Gaps sub-tab 点 "Report a gap" → detection_kind='explicit_report'
--
-- 关键设计：
--   - 按 gap_signature 去重 + occurrence_count 累计 + first/last_seen_at；
--     不为同一 missing tool 写多行，给 P8 propose 时一行一个判定即可。
--   - status 流转：open → proposed（P8 写）→ installed | wont_fix | rejected。
--     'wont_fix' 是用户决定不修；'rejected' 是 P8 propose 后人工驳回。
--   - 不打 source_tool_call_id / source_experience_id 的 FK 约束：
--     运维过程中可能 cascade 删，这里只做 best-effort 关联。
--
-- 回滚见 down-0063.sql。

-- ───────────────────────── tool_gap_log ─────────────────────────
CREATE TABLE IF NOT EXISTS `tool_gap_log` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL
    REFERENCES `project`(`id`) ON DELETE CASCADE,
  -- 关联 workflow / definition 仅用于 propose 时知道是哪个 agent 触发
  `workflow_run_id` TEXT,
  `definition_id` TEXT,

  -- 'unknown_tool' / 'repeated_fail' / 'reflective_mention' / 'explicit_report'
  `detection_kind` TEXT NOT NULL,

  -- 归一化 gap 标识，比如 'tool:get_weather' / 'mcp:slack/post_message' /
  -- 'concept:realtime_options_chain'。同 signature 累计 occurrence。
  `gap_signature` TEXT NOT NULL,

  -- 工具名（如果能推出来）
  `requested_tool_name` TEXT,
  -- 'mcp' / 'builtin' / 'unknown'
  `requested_tool_kind` TEXT,
  -- 触发样例：errorMessage 片段 / mention 原文 / 用户 reason
  `excerpt` TEXT,

  -- best-effort 关联，不打 FK
  `source_tool_call_id` TEXT,
  `source_experience_id` TEXT,

  -- 累计统计
  `occurrence_count` INTEGER NOT NULL DEFAULT 1,
  `first_seen_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `last_seen_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  -- 'open' / 'proposed' / 'installed' / 'wont_fix' / 'rejected'
  `status` TEXT NOT NULL DEFAULT 'open',
  `status_at` TEXT,
  `status_by` TEXT,
  `status_reason` TEXT,

  -- 自由扩展（例：requested_args_json / agent_message_id / errorSource）
  `metadata_json` TEXT NOT NULL DEFAULT '{}',

  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),

  CHECK (`detection_kind` IN
    ('unknown_tool', 'repeated_fail', 'reflective_mention', 'explicit_report')),
  CHECK (`status` IN
    ('open', 'proposed', 'installed', 'wont_fix', 'rejected'))
);
--> statement-breakpoint

-- 列表：按 project + status 列表
CREATE INDEX IF NOT EXISTS `idx_tool_gap_log_project_status`
  ON `tool_gap_log` (`project_id`, `status`, `last_seen_at`);
--> statement-breakpoint

-- dedup：worker 写入 / increment 时按 (project, signature, status='open') 查找
CREATE UNIQUE INDEX IF NOT EXISTS `idx_tool_gap_log_dedup_open`
  ON `tool_gap_log` (`project_id`, `gap_signature`)
  WHERE `status` = 'open';
--> statement-breakpoint

-- detection kind 维度统计 / 排查
CREATE INDEX IF NOT EXISTS `idx_tool_gap_log_kind`
  ON `tool_gap_log` (`project_id`, `detection_kind`, `last_seen_at`);
--> statement-breakpoint

-- ───────────────────────── tool_gap_run ─────────────────────────
-- 每次 ToolGapWatcher 跑批一行，给前端展示 + 故障复盘
CREATE TABLE IF NOT EXISTS `tool_gap_run` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL
    REFERENCES `project`(`id`) ON DELETE CASCADE,
  -- 'running' / 'completed' / 'failed'
  `status` TEXT NOT NULL DEFAULT 'running',
  `triggered_by` TEXT NOT NULL DEFAULT 'cron',

  -- 扫描窗口
  `from_ts` TEXT,
  `to_ts` TEXT,

  -- 三路 detector 各自命中数
  `unknown_tool_count` INTEGER NOT NULL DEFAULT 0,
  `repeated_fail_count` INTEGER NOT NULL DEFAULT 0,
  `reflective_mention_count` INTEGER NOT NULL DEFAULT 0,

  -- 总览
  `total_signals` INTEGER NOT NULL DEFAULT 0,
  `gaps_created` INTEGER NOT NULL DEFAULT 0,
  `gaps_incremented` INTEGER NOT NULL DEFAULT 0,
  `gaps_skipped` INTEGER NOT NULL DEFAULT 0,

  `actions_json` TEXT NOT NULL DEFAULT '[]',
  `elapsed_ms` INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT,
  `started_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_tool_gap_run_project`
  ON `tool_gap_run` (`project_id`, `started_at`);
