CREATE TABLE IF NOT EXISTS workflow_compensation_task (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_run(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
  action_type TEXT NOT NULL CHECK(action_type IN ('retry_from_start','resume','manual_intervention')),
  reason TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  payload_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS broker_account (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('futu','ib')),
  account_ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','sandbox','live')),
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown','healthy','degraded','down')),
  health_message TEXT,
  last_health_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS broker_order_event (
  id TEXT PRIMARY KEY,
  intent_order_id TEXT REFERENCES intent_order(id),
  execution_report_id TEXT REFERENCES execution_report(id),
  provider TEXT NOT NULL CHECK(provider IN ('futu','ib')),
  event_type TEXT NOT NULL CHECK(event_type IN ('submit','ack','partial_fill','fill','cancel','reject','health_check')),
  broker_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  detail_json TEXT NOT NULL DEFAULT '{}',
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_workflow_comp_task_workflow_status ON workflow_compensation_task(workflow_run_id, status, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_broker_account_provider_enabled ON broker_account(provider, enabled);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_broker_order_event_intent_created ON broker_order_event(intent_order_id, created_at DESC);
