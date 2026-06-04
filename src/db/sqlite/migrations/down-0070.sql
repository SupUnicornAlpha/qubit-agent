-- Rollback Schema 收敛 C5-1（详见 0070_drop_acp_call.sql）

CREATE TABLE IF NOT EXISTS acp_call (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  trace_id TEXT NOT NULL,
  agent_step_id TEXT,
  caller_instance_id TEXT NOT NULL REFERENCES agent_instance(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('skill','mcp','tool','connector')),
  target_name TEXT NOT NULL,
  intent TEXT NOT NULL,
  input_schema_version TEXT NOT NULL DEFAULT '1.0',
  output_schema_version TEXT,
  latency_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('success','error','timeout','blocked_by_sandbox')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
