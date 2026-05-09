-- M8 MCP runtime dispatcher persistence
CREATE TABLE IF NOT EXISTS mcp_tool_binding (
  id TEXT PRIMARY KEY,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER,
  retry_policy_json TEXT NOT NULL DEFAULT '{}',
  rate_limit_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mcp_call_log (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  agent_step_id TEXT NOT NULL REFERENCES agent_step(id),
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT,
  status TEXT NOT NULL CHECK(status IN ('success','timeout','failed','sandbox_blocked')),
  error_code TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mcp_binding_server_tool ON mcp_tool_binding(server_name, tool_name);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mcp_call_workflow ON mcp_call_log(workflow_run_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mcp_call_step ON mcp_call_log(agent_step_id, created_at DESC);
