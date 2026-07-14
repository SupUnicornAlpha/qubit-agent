ALTER TABLE order_intent ADD COLUMN stop_price REAL;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN trailing_offset_pct REAL;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN trailing_anchor_price REAL;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN parent_order_intent_id TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN oco_group_id TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN activation_status TEXT NOT NULL DEFAULT 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_parent ON order_intent(parent_order_intent_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_oco ON order_intent(oco_group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_activation ON order_intent(activation_status, lifecycle_status);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE execution_task_new (
  id TEXT PRIMARY KEY NOT NULL,
  order_intent_id TEXT NOT NULL REFERENCES order_intent(id),
  account_id TEXT NOT NULL REFERENCES trading_account(id),
  status TEXT NOT NULL CHECK(status IN (
    'pending','held','conditional_wait','awaiting_review','dispatching','waiting_ack',
    'partially_filled','filled','cancelled','rejected','failed'
  )),
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  last_error TEXT,
  trace_id TEXT NOT NULL DEFAULT '',
  broker_account_id TEXT REFERENCES broker_account(id),
  dispatch_mode TEXT NOT NULL DEFAULT 'paper' CHECK(dispatch_mode IN ('paper','live')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
INSERT INTO execution_task_new SELECT
  id, order_intent_id, account_id, status, retry_count, max_retries, next_retry_at,
  last_error, trace_id, broker_account_id, dispatch_mode, created_at, updated_at
FROM execution_task;
--> statement-breakpoint
CREATE TABLE execution_task_event_new (
  id TEXT PRIMARY KEY NOT NULL,
  execution_task_id TEXT NOT NULL REFERENCES execution_task_new(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'dispatch','trigger','activate','ack','partial_fill','fill','cancel','reject','timeout','retry'
  )),
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
INSERT INTO execution_task_event_new SELECT
  id, execution_task_id, event_type, event_payload_json, event_at, created_at
FROM execution_task_event;
--> statement-breakpoint
DROP TABLE execution_task_event;
--> statement-breakpoint
DROP TABLE execution_task;
--> statement-breakpoint
ALTER TABLE execution_task_new RENAME TO execution_task;
--> statement-breakpoint
ALTER TABLE execution_task_event_new RENAME TO execution_task_event;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_execution_task_order_intent_unique ON execution_task(order_intent_id);
--> statement-breakpoint
CREATE INDEX idx_execution_task_status_next_retry ON execution_task(status, next_retry_at, created_at);
--> statement-breakpoint
CREATE INDEX idx_execution_task_event_task_time ON execution_task_event(execution_task_id, event_at);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
