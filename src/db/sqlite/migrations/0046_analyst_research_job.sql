CREATE TABLE IF NOT EXISTS analyst_research_job (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',
  ticker TEXT NOT NULL DEFAULT '',
  resume_payload_json TEXT,
  result_json TEXT,
  error_message TEXT,
  hitl_request_id TEXT,
  hitl_title TEXT,
  hitl_summary TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_analyst_research_job_workflow
  ON analyst_research_job(workflow_run_id, status);
