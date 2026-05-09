-- M9 observability metrics snapshots
CREATE TABLE IF NOT EXISTS agent_runtime_metric (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES agent_definition(id),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  run_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  timeout_count INTEGER NOT NULL DEFAULT 0,
  p50_latency_ms REAL,
  p95_latency_ms REAL,
  avg_token_count REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS workflow_quality_snapshot (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  total_duration_ms INTEGER,
  total_tool_calls INTEGER NOT NULL DEFAULT 0,
  sandbox_block_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_agent_runtime_metric_def_window ON agent_runtime_metric(definition_id, window_start, window_end);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_quality_snapshot_workflow ON workflow_quality_snapshot(workflow_run_id, created_at DESC);
