-- Add a signal-only strategy runtime mode.  Shadow evaluates exactly the same
-- closed bars as a deployable runtime, but it must never create an order intent,
-- execution task, broker request or position mutation.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE strategy_runtime_new (
  id TEXT PRIMARY KEY NOT NULL,
  strategy_script_id TEXT NOT NULL REFERENCES indicator_strategy_script(id) ON DELETE CASCADE,
  broker_account_id TEXT REFERENCES broker_account(id),
  status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN ('stopped','starting','running','error','stopping')),
  execution_mode TEXT NOT NULL DEFAULT 'paper' CHECK(execution_mode IN ('paper','live','sim','shadow')),
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
