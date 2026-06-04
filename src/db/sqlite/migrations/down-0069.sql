-- Rollback Schema 收敛 C5-2（详见 0069_drop_connector_call_log.sql）

CREATE TABLE IF NOT EXISTS connector_call_log (
  id TEXT PRIMARY KEY,
  connector_instance_id TEXT REFERENCES connector_instance(id),
  connector_name TEXT NOT NULL DEFAULT '',
  workflow_run_id TEXT REFERENCES workflow_run(id),
  acp_call_id TEXT REFERENCES acp_call(id),
  trace_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('init','healthcheck','execute','shutdown')),
  request_json TEXT NOT NULL,
  response_json TEXT,
  latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','error','timeout')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
