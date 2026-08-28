-- Agent Eval Platform P0: unified Score store + dataset items + experiment metadata.

CREATE TABLE IF NOT EXISTS agent_score (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('NUMERIC', 'CATEGORICAL', 'BOOLEAN', 'TEXT')),
  value_numeric REAL,
  value_categorical TEXT,
  value_boolean INTEGER,
  value_text TEXT,
  comment TEXT,
  source TEXT NOT NULL CHECK (source IN ('heuristic', 'llm_judge', 'code', 'human', 'domain_plugin')),
  evaluator_id TEXT,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  observation_id TEXT,
  session_id TEXT REFERENCES chat_session(id) ON DELETE SET NULL,
  eval_run_id TEXT REFERENCES eval_run(id) ON DELETE SET NULL,
  dataset_item_id TEXT,
  config_fingerprint TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_score_workflow_name
  ON agent_score (workflow_run_id, name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_score_name_created
  ON agent_score (name, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_score_session_name
  ON agent_score (session_id, name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_dataset_item (
  id TEXT PRIMARY KEY NOT NULL,
  dataset_id TEXT NOT NULL REFERENCES eval_dataset(id) ON DELETE CASCADE,
  case_key TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  expected_json TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  source_workflow_run_id TEXT REFERENCES workflow_run(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (dataset_id, case_key)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_eval_dataset_item_dataset
  ON eval_dataset_item (dataset_id, created_at DESC);
--> statement-breakpoint
ALTER TABLE eval_run ADD COLUMN config_fingerprint TEXT;
--> statement-breakpoint
ALTER TABLE eval_run ADD COLUMN experiment_label TEXT;
