-- M9 alert center + M10 evaluation schema
CREATE TABLE IF NOT EXISTS alert_event (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('workflow','agent','system')),
  scope_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warn','error','critical')),
  title TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','ack','resolved')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_dataset (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT 'v1',
  scenario TEXT NOT NULL DEFAULT 'mixed',
  source_desc TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_run (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES eval_dataset(id),
  config_snapshot_json TEXT NOT NULL DEFAULT '{}',
  model_snapshot_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  summary_metrics_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS eval_case_result (
  id TEXT PRIMARY KEY,
  eval_run_id TEXT NOT NULL REFERENCES eval_run(id),
  case_key TEXT NOT NULL,
  workflow_run_id TEXT REFERENCES workflow_run(id),
  expected_json TEXT NOT NULL DEFAULT '{}',
  actual_json TEXT NOT NULL DEFAULT '{}',
  score REAL NOT NULL DEFAULT 0,
  pass INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_alert_scope_status ON alert_event(scope_type, scope_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_eval_run_dataset ON eval_run(dataset_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_eval_case_run ON eval_case_result(eval_run_id, created_at DESC);
