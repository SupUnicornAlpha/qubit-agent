CREATE TABLE IF NOT EXISTS workflow_hitl_request (
  id TEXT PRIMARY KEY NOT NULL,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE,
  run_id TEXT,
  agent_instance_id TEXT,
  step_index INTEGER NOT NULL DEFAULT 0,
  scope TEXT NOT NULL DEFAULT 'chat_orchestrator',
  request_kind TEXT NOT NULL DEFAULT 'tool_call',
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_hitl_request_workflow
  ON workflow_hitl_request(workflow_run_id, status, created_at);
