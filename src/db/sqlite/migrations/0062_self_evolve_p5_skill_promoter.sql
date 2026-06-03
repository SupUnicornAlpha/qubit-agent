-- Self-Evolving Agent P5 — SkillPromoter（详见 docs/SELF_EVOLVING_AGENT_DESIGN.md §P5）
--
-- 在 P4b PnL 反馈环已经把 agent_skill.pnl_attribution_json 灌满数据之后，让
-- SkillPromoter 周期性扫候选（procedural / reflective），按规则评分 →
-- 候选直接落 agent_skill(state='pending_review')（schema 已有该 enum），
-- 用户在 MemoryTab > Skill Promotions sub-tab 一键 approve/reject。
--
-- 改动总览：
--   1) 新表 skill_promotion_run：每次跑批一行（仿 skill_curator_run 模式），
--      summary + actions_json 给前端展示 + 故障复盘；
--   2) agent_skill 新增 3 个 promotion 相关字段：
--      - promotion_run_id：标这个 skill 是哪一次 promoter 跑批写的（nullable，user_authored
--        / pre-P5 的不写）
--      - promotion_score：评分 0~1（按规则加权），影响列表排序
--      - promotion_review_at：approve / reject 的时间（nullable）
--   3) 索引：(project, state, promotion_run_id) 拉某次跑批结果；
--           (promotion_score DESC) 按分排序前端列表。
--
-- 设计取舍：
--   - 选 1：不开新的 skill_promotion_candidate 表，让 candidate 直接复用 agent_skill —
--     这样 approve 时只需 UPDATE state；reject 时只需 UPDATE state='archived'，
--     不用搬数据；前端列表也只查一张表。
--   - 选 2：promotion_run_id 不打外键约束（数据生命周期错位：用户在 archive 旧 run
--     不应该级联删 pending_review skill），由 worker 自己保证写入一致性。
--   - 选 3：reject 的反馈写到 experience(reflective, sub_kind='skill_reject_feedback')
--     而不是单独表，让 Reflector 框架自动消化（无需新机制）。
--
-- 回滚见 down-0062.sql。

-- ───────────────────────── skill_promotion_run ─────────────────────────
CREATE TABLE IF NOT EXISTS `skill_promotion_run` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL
    REFERENCES `project`(`id`) ON DELETE CASCADE,
  -- 'dry_run' 仅打分不写 agent_skill；'live' 真写 pending_review
  `mode` TEXT NOT NULL DEFAULT 'dry_run',
  -- 'running' / 'completed' / 'failed'
  `status` TEXT NOT NULL DEFAULT 'running',
  -- 'cron' / 'manual' / 'api'
  `triggered_by` TEXT NOT NULL DEFAULT 'cron',
  -- 扫到的候选总数（含被规则过滤掉的）
  `total_scanned` INTEGER NOT NULL DEFAULT 0,
  -- 通过规则的（这次会落 pending_review 的）
  `total_qualified` INTEGER NOT NULL DEFAULT 0,
  -- 实际成功 upsert agent_skill 行数
  `total_promoted` INTEGER NOT NULL DEFAULT 0,
  -- 候选已经被 promote 过（同 signature 已存在）跳过数
  `total_skipped_duplicate` INTEGER NOT NULL DEFAULT 0,
  -- 候选数据不足（无 successCount / 无 useCount）跳过数
  `total_skipped_insufficient` INTEGER NOT NULL DEFAULT 0,
  -- 候选明细 + 评分 + 命中规则；前端展示用，最大保留 200 条
  -- 结构：[{candidateKind, candidateId, signature, score, ruleHits, recallCount, ...}, ...]
  `actions_json` TEXT NOT NULL DEFAULT '[]',
  -- 跑批耗时 ms，给 SLO 用
  `elapsed_ms` INTEGER NOT NULL DEFAULT 0,
  `error_message` TEXT,
  `started_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` TEXT
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_skill_promotion_run_project`
  ON `skill_promotion_run` (`project_id`, `started_at`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_skill_promotion_run_status`
  ON `skill_promotion_run` (`status`, `started_at`);
--> statement-breakpoint

-- ───────────────────────── agent_skill 补 promotion 字段 ─────────────────────────

-- 这个 skill 是哪一次 promoter run 写的；user_authored / pre-P5 自动写的 skill 不写值
-- 不打 FK：保留"删 run 不影响 skill"语义
ALTER TABLE `agent_skill` ADD COLUMN `promotion_run_id` TEXT;
--> statement-breakpoint

-- 0~1 评分。规则维度：recall_count / success_rate / pnl_signal / diversity；越大越优先
ALTER TABLE `agent_skill` ADD COLUMN `promotion_score` REAL;
--> statement-breakpoint

-- user approve / reject 的时间；前端列表按 state + 这字段排序
ALTER TABLE `agent_skill` ADD COLUMN `promotion_review_at` TEXT;
--> statement-breakpoint

-- 列表查询：某 project 某 promotion_run 下所有 pending_review 的 skill
CREATE INDEX IF NOT EXISTS `idx_agent_skill_promotion_run`
  ON `agent_skill` (`project_id`, `state`, `promotion_run_id`);
--> statement-breakpoint

-- 按分排序（前端 pending_review 列表默认排序）
CREATE INDEX IF NOT EXISTS `idx_agent_skill_promotion_score`
  ON `agent_skill` (`project_id`, `state`, `promotion_score`);
