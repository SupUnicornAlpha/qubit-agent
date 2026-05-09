-- V2 Stock Screener
CREATE TABLE IF NOT EXISTS screener_run (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  criteria_json TEXT NOT NULL DEFAULT '{}',
  universe TEXT NOT NULL DEFAULT 'CN-A',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS screener_candidate (
  id TEXT PRIMARY KEY,
  screener_run_id TEXT NOT NULL REFERENCES screener_run(id),
  ticker TEXT NOT NULL,
  company_name TEXT NOT NULL,
  score REAL NOT NULL,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  passed_to_analyst INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_screener_run_workflow ON screener_run(workflow_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_screener_candidate_run_score ON screener_candidate(screener_run_id, score DESC);
