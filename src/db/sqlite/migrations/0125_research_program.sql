CREATE TABLE `research_protocol` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `project`(`id`) ON DELETE RESTRICT,
  `version` INTEGER NOT NULL CHECK (`version` > 0),
  `fingerprint` TEXT NOT NULL,
  `spec_json` TEXT NOT NULL CHECK (json_valid(`spec_json`)),
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_protocol_version` ON `research_protocol` (`project_id`, `version`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_protocol_project_identity` ON `research_protocol` (`id`, `project_id`);
--> statement-breakpoint
CREATE TABLE `research_program` (
  `project_id` TEXT PRIMARY KEY NOT NULL REFERENCES `project`(`id`) ON DELETE RESTRICT,
  `active_protocol_id` TEXT NOT NULL REFERENCES `research_protocol`(`id`) ON DELETE RESTRICT,
  `status` TEXT NOT NULL DEFAULT 'active' CHECK (`status` IN ('active','paused')),
  `max_attempts` INTEGER NOT NULL CHECK (`max_attempts` > 0),
  `max_evaluations` INTEGER NOT NULL CHECK (`max_evaluations` >= 0 AND `max_evaluations` <= `max_attempts`),
  `used_attempts` INTEGER NOT NULL DEFAULT 0 CHECK (`used_attempts` >= 0 AND `used_attempts` <= `max_attempts`),
  `used_evaluations` INTEGER NOT NULL DEFAULT 0 CHECK (`used_evaluations` >= 0 AND `used_evaluations` <= `max_evaluations` AND `used_evaluations` <= `used_attempts`),
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `updated_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (`active_protocol_id`, `project_id`) REFERENCES `research_protocol` (`id`, `project_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `research_evaluation_budget` (
  `key` TEXT PRIMARY KEY NOT NULL,
  `limit` INTEGER NOT NULL CHECK (`limit` > 0),
  `used` INTEGER NOT NULL DEFAULT 0 CHECK (`used` >= 0 AND `used` <= `limit`),
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE `research_attempt` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `research_program`(`project_id`) ON DELETE RESTRICT,
  `protocol_id` TEXT NOT NULL REFERENCES `research_protocol`(`id`) ON DELETE RESTRICT,
  `kind` TEXT NOT NULL CHECK (`kind` IN ('factor_compute','factor_evaluate','backtest','sealed_factor')),
  `candidate_id` TEXT NOT NULL,
  `candidate_json` TEXT NOT NULL CHECK (json_valid(`candidate_json`)),
  `request_json` TEXT NOT NULL CHECK (json_valid(`request_json`)),
  `request_fingerprint` TEXT NOT NULL,
  `idempotency_key` TEXT NOT NULL,
  `evaluation_budget_key` TEXT REFERENCES `research_evaluation_budget`(`key`) ON DELETE RESTRICT,
  `status` TEXT NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending','running','completed','failed','cancelled','timed_out')),
  `result_json` TEXT CHECK (`result_json` IS NULL OR json_valid(`result_json`)),
  `error` TEXT,
  `created_at` TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  `started_at` TEXT,
  `ended_at` TEXT,
  `deadline_at` TEXT NOT NULL,
  CHECK ((`kind` = 'sealed_factor') = (`evaluation_budget_key` IS NOT NULL)),
  FOREIGN KEY (`protocol_id`, `project_id`) REFERENCES `research_protocol` (`id`, `project_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_research_attempt_idempotency` ON `research_attempt` (`project_id`, `idempotency_key`);
--> statement-breakpoint
CREATE INDEX `idx_research_attempt_project` ON `research_attempt` (`project_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_research_attempt_expiry` ON `research_attempt` (`status`, `deadline_at`);
--> statement-breakpoint
CREATE TRIGGER `research_protocol_no_update` BEFORE UPDATE ON `research_protocol`
BEGIN SELECT RAISE(ABORT, 'research_protocol_is_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `research_protocol_no_delete` BEFORE DELETE ON `research_protocol`
BEGIN SELECT RAISE(ABORT, 'research_protocol_history_is_retained'); END;
--> statement-breakpoint
CREATE TRIGGER `research_program_budget_immutable` BEFORE UPDATE ON `research_program`
WHEN NEW.max_attempts <> OLD.max_attempts OR NEW.max_evaluations <> OLD.max_evaluations
BEGIN SELECT RAISE(ABORT, 'research_program_budget_is_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER `research_evaluation_budget_immutable` BEFORE UPDATE ON `research_evaluation_budget`
WHEN NEW.`limit` <> OLD.`limit`
BEGIN SELECT RAISE(ABORT, 'research_evaluation_budget_is_immutable'); END;
