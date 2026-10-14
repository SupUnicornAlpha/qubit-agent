CREATE TABLE `research_attempt_next` (
  `id` TEXT PRIMARY KEY NOT NULL,
  `project_id` TEXT NOT NULL REFERENCES `research_program`(`project_id`) ON DELETE RESTRICT,
  `protocol_id` TEXT NOT NULL REFERENCES `research_protocol`(`id`) ON DELETE RESTRICT,
  `kind` TEXT NOT NULL CHECK (`kind` IN ('factor_compute','factor_evaluate','backtest','sealed_factor','sealed_strategy','paper_step')),
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
  CHECK ((`kind` IN ('sealed_factor','sealed_strategy')) = (`evaluation_budget_key` IS NOT NULL)),
  FOREIGN KEY (`protocol_id`, `project_id`) REFERENCES `research_protocol` (`id`, `project_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO research_attempt_next SELECT * FROM research_attempt;
--> statement-breakpoint
DROP TABLE research_attempt;
--> statement-breakpoint
ALTER TABLE research_attempt_next RENAME TO research_attempt;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_research_attempt_idempotency ON research_attempt(project_id,idempotency_key);
--> statement-breakpoint
CREATE INDEX idx_research_attempt_project ON research_attempt(project_id,created_at);
--> statement-breakpoint
CREATE INDEX idx_research_attempt_expiry ON research_attempt(status,deadline_at);
--> statement-breakpoint
CREATE TABLE research_strategy_event (
 id TEXT PRIMARY KEY NOT NULL,
 project_id TEXT NOT NULL REFERENCES research_program(project_id) ON DELETE RESTRICT,
 version_id TEXT NOT NULL REFERENCES strategy_version(id) ON DELETE RESTRICT,
 sequence INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('state','validation_plan','paper_session','paper_status')),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 created_at TEXT NOT NULL,
 UNIQUE(version_id,sequence)
);
--> statement-breakpoint
CREATE TRIGGER research_strategy_event_no_update BEFORE UPDATE ON research_strategy_event
BEGIN SELECT RAISE(ABORT,'research_strategy_history_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER research_strategy_event_no_delete BEFORE DELETE ON research_strategy_event
BEGIN SELECT RAISE(ABORT,'research_strategy_history_retained'); END;
