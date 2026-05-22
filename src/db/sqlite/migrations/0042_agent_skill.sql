-- M11: Agent 自进化骨架（agent_skill / agent_skill_run / skill_curator_run）
-- 设计目标：
--   1. 让 Agent 能把"完成 5+ 工具调用的复杂任务/跨会话稳定流程"沉淀为 skill（参考 Hermes Agent）
--   2. 区分外部市场安装（source=open_skill_market，external_install_id 指向 skill_market_install）
--      与 Agent 自建（source=agent_created）
--   3. 版本谱系（parent_skill_id）供后续 Curator 合并 / Evolution 演化保留
--   4. 周期性 Curator 审阅记录（skill_curator_run）—— dry_run / live 都落痕，可由 UI 审批
CREATE TABLE IF NOT EXISTS `agent_skill` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `definition_id` text REFERENCES `agent_definition`(`id`) ON DELETE SET NULL,
  `name` text NOT NULL,
  `description` text NOT NULL DEFAULT '',
  `body_md` text NOT NULL DEFAULT '',
  `category` text NOT NULL DEFAULT 'general',
  `version` text NOT NULL DEFAULT 'v1',
  `parent_skill_id` text REFERENCES `agent_skill`(`id`) ON DELETE SET NULL,
  `source` text NOT NULL DEFAULT 'agent_created'
    CHECK (`source` IN ('agent_created', 'user_authored', 'open_skill_market', 'evolved')),
  `external_install_id` text REFERENCES `skill_market_install`(`id`) ON DELETE SET NULL,
  `state` text NOT NULL DEFAULT 'active'
    CHECK (`state` IN ('active', 'stale', 'archived', 'pending_review')),
  `pinned` integer NOT NULL DEFAULT 0,
  `use_count` integer NOT NULL DEFAULT 0,
  `success_count` integer NOT NULL DEFAULT 0,
  `fail_count` integer NOT NULL DEFAULT 0,
  `last_used_at` text,
  `metadata_json` text NOT NULL DEFAULT '{}',
  `created_by` text NOT NULL DEFAULT 'agent',
  `created_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_agent_skill_project_name` ON `agent_skill` (`project_id`, `name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_skill_project_state` ON `agent_skill` (`project_id`, `state`, `last_used_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_skill_definition` ON `agent_skill` (`definition_id`, `state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_skill_parent` ON `agent_skill` (`parent_skill_id`);
--> statement-breakpoint
-- 每次 skill 被 agent 召回/使用都记一条，供 Curator 决定 stale/archive、Evolution 选择高频目标
CREATE TABLE IF NOT EXISTS `agent_skill_run` (
  `id` text PRIMARY KEY NOT NULL,
  `skill_id` text NOT NULL REFERENCES `agent_skill`(`id`) ON DELETE CASCADE,
  `workflow_run_id` text REFERENCES `workflow_run`(`id`) ON DELETE SET NULL,
  `agent_instance_id` text REFERENCES `agent_instance`(`id`) ON DELETE SET NULL,
  `definition_id` text REFERENCES `agent_definition`(`id`) ON DELETE SET NULL,
  `outcome` text NOT NULL DEFAULT 'unknown'
    CHECK (`outcome` IN ('success', 'fail', 'partial', 'unknown')),
  `score` real,
  `notes` text NOT NULL DEFAULT '',
  `started_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_skill_run_skill` ON `agent_skill_run` (`skill_id`, `started_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agent_skill_run_workflow` ON `agent_skill_run` (`workflow_run_id`);
--> statement-breakpoint
-- Curator 评审记录；dry_run 与 live 都落，live 通过审批后才真正应用
CREATE TABLE IF NOT EXISTS `skill_curator_run` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `mode` text NOT NULL DEFAULT 'dry_run' CHECK (`mode` IN ('dry_run', 'live')),
  `status` text NOT NULL DEFAULT 'running'
    CHECK (`status` IN ('running', 'completed', 'failed')),
  `triggered_by` text NOT NULL DEFAULT 'cron',
  `total_checked` integer NOT NULL DEFAULT 0,
  `marked_stale` integer NOT NULL DEFAULT 0,
  `archived` integer NOT NULL DEFAULT 0,
  `consolidated` integer NOT NULL DEFAULT 0,
  `pruned` integer NOT NULL DEFAULT 0,
  `summary_text` text NOT NULL DEFAULT '',
  `summary_yaml` text NOT NULL DEFAULT '',
  `actions_json` text NOT NULL DEFAULT '[]',
  `error_message` text,
  `started_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_curator_run_project` ON `skill_curator_run` (`project_id`, `started_at` DESC);
--> statement-breakpoint
-- Skill 演化（GEPA-lite）— 每跑一次评测 + 选优，写一条 skill_evolution_run
CREATE TABLE IF NOT EXISTS `skill_evolution_run` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL REFERENCES `project`(`id`) ON DELETE CASCADE,
  `base_skill_id` text NOT NULL REFERENCES `agent_skill`(`id`) ON DELETE CASCADE,
  `dataset_id` text REFERENCES `eval_dataset`(`id`),
  `iterations` integer NOT NULL DEFAULT 5,
  `candidates_evaluated` integer NOT NULL DEFAULT 0,
  `baseline_score` real,
  `best_score` real,
  `winning_skill_id` text REFERENCES `agent_skill`(`id`) ON DELETE SET NULL,
  `status` text NOT NULL DEFAULT 'running'
    CHECK (`status` IN ('running', 'completed', 'failed')),
  `report_json` text NOT NULL DEFAULT '{}',
  `error_message` text,
  `triggered_by` text NOT NULL DEFAULT 'user',
  `started_at` text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `ended_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_evolution_base` ON `skill_evolution_run` (`base_skill_id`, `started_at` DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_skill_evolution_project` ON `skill_evolution_run` (`project_id`, `started_at` DESC);
