-- Allow dispatch_mode / execution_mode = 'sim' (券商模拟盘，如 Futu TrdEnv.SIMULATE)。
-- paper = 本地假成交；sim = 真券商模拟盘；live = 真券商实盘。

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
  dispatch_mode TEXT NOT NULL DEFAULT 'paper' CHECK(dispatch_mode IN ('paper','live','sim')),
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
CREATE TABLE strategy_runtime_new (
  id TEXT PRIMARY KEY NOT NULL,
  strategy_script_id TEXT NOT NULL REFERENCES indicator_strategy_script(id) ON DELETE CASCADE,
  broker_account_id TEXT REFERENCES broker_account(id),
  status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('stopped','starting','running','error','stopping')),
  execution_mode TEXT NOT NULL DEFAULT 'paper' CHECK(execution_mode IN ('paper','live','sim')),
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1d',
  params_json TEXT NOT NULL DEFAULT '{}',
  last_bar_time TEXT,
  last_signal_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
INSERT INTO strategy_runtime_new SELECT
  id, strategy_script_id, broker_account_id, status, execution_mode, market, symbol,
  timeframe, params_json, last_bar_time, last_signal_at, error_message, created_at, updated_at
FROM strategy_runtime;
--> statement-breakpoint
DROP TABLE strategy_runtime;
--> statement-breakpoint
ALTER TABLE strategy_runtime_new RENAME TO strategy_runtime;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_status ON strategy_runtime(status);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
