-- V2 Risk-First Veto (RFV)
CREATE TABLE IF NOT EXISTS risk_veto_log (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  risk_instance_id TEXT REFERENCES agent_instance(id),
  veto_target TEXT NOT NULL,
  veto_reason TEXT NOT NULL,
  risk_score REAL NOT NULL,
  risk_rules_triggered_json TEXT NOT NULL DEFAULT '[]',
  severity TEXT NOT NULL DEFAULT 'block' CHECK(severity IN ('warning','block','critical')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_risk_veto_workflow ON risk_veto_log(workflow_run_id);
