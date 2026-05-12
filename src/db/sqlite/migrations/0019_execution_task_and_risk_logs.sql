CREATE TABLE IF NOT EXISTS execution_task (
  id TEXT PRIMARY KEY NOT NULL,
  order_intent_id TEXT NOT NULL REFERENCES order_intent(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  account_id TEXT NOT NULL REFERENCES trading_account(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  status TEXT NOT NULL CHECK(status IN (
    'pending',
    'awaiting_review',
    'dispatching',
    'waiting_ack',
    'partially_filled',
    'filled',
    'cancelled',
    'rejected',
    'failed'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  last_error TEXT,
  trace_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS execution_task_event (
  id TEXT PRIMARY KEY NOT NULL,
  execution_task_id TEXT NOT NULL REFERENCES execution_task(id) ON DELETE CASCADE ON UPDATE NO ACTION,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'dispatch','ack','partial_fill','fill','cancel','reject','timeout','retry'
  )),
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS risk_hit_log (
  id TEXT PRIMARY KEY NOT NULL,
  order_intent_id TEXT NOT NULL REFERENCES order_intent(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  risk_rule_id TEXT NOT NULL REFERENCES risk_rule(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  hit INTEGER NOT NULL,
  hit_value REAL,
  threshold_value REAL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warn','block','critical')),
  message TEXT NOT NULL DEFAULT '',
  evaluated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS risk_review_ticket (
  id TEXT PRIMARY KEY NOT NULL,
  order_intent_id TEXT NOT NULL REFERENCES order_intent(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  status TEXT NOT NULL CHECK(status IN ('open','approved','rejected','expired')),
  reviewer TEXT,
  review_note TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_task_order_intent_unique ON execution_task(order_intent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_execution_task_status_next_retry ON execution_task(status, next_retry_at, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_execution_task_event_task_time ON execution_task_event(execution_task_id, event_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_risk_hit_log_intent ON risk_hit_log(order_intent_id, evaluated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_risk_review_ticket_intent ON risk_review_ticket(order_intent_id, status);
--> statement-breakpoint
INSERT OR IGNORE INTO trading_account (id, broker, market_scope, mode, status) VALUES
  ('ta_builtin_paper', 'builtin_paper', '*', 'paper', 'active');
--> statement-breakpoint
INSERT OR IGNORE INTO connector_spec (
  id, name, connector_type, version, capabilities_json, asset_classes_json, latency_profile, schema_contract_json
) VALUES (
  'cs_builtin_paper_execution',
  'builtin-paper-execution',
  'execution',
  '1.0.0',
  '{"paper":true,"modes":["paper"]}',
  '["stock","crypto","future","fx"]',
  'realtime',
  '{"orders":{"submit":"object","fills":"array"}}'
);
--> statement-breakpoint
INSERT OR IGNORE INTO connector_instance (
  id, spec_id, env, config_ref, status, last_healthcheck_at
) VALUES (
  'ci_builtin_paper_execution',
  'cs_builtin_paper_execution',
  'dev',
  'builtin:paper',
  'active',
  (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
