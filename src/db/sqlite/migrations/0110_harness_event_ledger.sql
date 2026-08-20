-- 0110_harness_event_ledger — append-only Cross-Capability / Tool Pipeline audit events.

CREATE TABLE harness_event_ledger (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  trace_id TEXT,
  turn_id TEXT,
  step_id TEXT,
  tool_call_id TEXT,
  capability_id TEXT,
  profile_id TEXT,
  dedupe_key TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'capability.composed',
    'tool.admitted',
    'tool.rejected',
    'tool.started',
    'tool.completed',
    'artifact.created'
  )),
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX idx_harness_event_ledger_workflow_created
  ON harness_event_ledger(workflow_run_id, created_at);
--> statement-breakpoint
CREATE INDEX idx_harness_event_ledger_trace_created
  ON harness_event_ledger(trace_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX uq_harness_event_ledger_workflow_dedupe
  ON harness_event_ledger(workflow_run_id, dedupe_key);
--> statement-breakpoint
CREATE TRIGGER harness_event_ledger_reject_update
BEFORE UPDATE ON harness_event_ledger
BEGIN
  SELECT RAISE(ABORT, 'harness_event_ledger is append-only');
END;
