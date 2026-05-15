-- Strategy runtime: bar-driven live/paper signal execution.

CREATE TABLE IF NOT EXISTS strategy_runtime (
  id TEXT PRIMARY KEY NOT NULL,
  strategy_script_id TEXT NOT NULL REFERENCES indicator_strategy_script(id) ON DELETE CASCADE,
  broker_account_id TEXT REFERENCES broker_account(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'stopped' CHECK(status IN (
    'stopped', 'starting', 'running', 'error', 'stopping'
  )),
  execution_mode TEXT NOT NULL DEFAULT 'paper' CHECK(execution_mode IN ('paper', 'live')),
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1d',
  params_json TEXT NOT NULL DEFAULT '{}',
  last_bar_time TEXT,
  last_signal_at TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS strategy_runtime_log (
  id TEXT PRIMARY KEY NOT NULL,
  strategy_runtime_id TEXT NOT NULL REFERENCES strategy_runtime(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info' CHECK(level IN ('debug', 'info', 'warn', 'error')),
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS strategy_position_snapshot (
  id TEXT PRIMARY KEY NOT NULL,
  strategy_runtime_id TEXT NOT NULL REFERENCES strategy_runtime(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  avg_price REAL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(strategy_runtime_id, symbol)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS strategy_signal_dedup (
  id TEXT PRIMARY KEY NOT NULL,
  strategy_runtime_id TEXT NOT NULL REFERENCES strategy_runtime(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK(signal_type IN ('buy', 'sell')),
  signal_bar_time TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(strategy_runtime_id, symbol, signal_type, signal_bar_time)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_status ON strategy_runtime(status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_log_runtime ON strategy_runtime_log(strategy_runtime_id, created_at);
