-- V2 Research-Execution Intent Alignment (REIA)
CREATE TABLE IF NOT EXISTS intent_order (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  created_by_instance_id TEXT REFERENCES agent_instance(id),
  ticker TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('long','short','close')),
  quantity REAL NOT NULL,
  target_price REAL NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  expected_return REAL,
  expected_risk REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','executed','deviated')),
  risk_approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_report (
  id TEXT PRIMARY KEY,
  intent_order_id TEXT NOT NULL REFERENCES intent_order(id),
  executor_instance_id TEXT REFERENCES agent_instance(id),
  actual_price REAL NOT NULL,
  actual_quantity REAL NOT NULL,
  slippage REAL NOT NULL,
  execution_time_ms INTEGER NOT NULL,
  broker_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'filled' CHECK(status IN ('filled','partial','rejected','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS intent_deviation (
  id TEXT PRIMARY KEY,
  intent_order_id TEXT NOT NULL REFERENCES intent_order(id),
  execution_report_id TEXT NOT NULL REFERENCES execution_report(id),
  price_deviation_pct REAL NOT NULL,
  quantity_deviation_pct REAL NOT NULL,
  exceeded_threshold INTEGER NOT NULL DEFAULT 0,
  callback_triggered INTEGER NOT NULL DEFAULT 0,
  callback_workflow_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_intent_order_workflow ON intent_order(workflow_run_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_execution_report_intent ON execution_report(intent_order_id);
