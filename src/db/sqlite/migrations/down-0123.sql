-- Roll back shadow runtime mode. The INSERT below intentionally fails its
-- CHECK constraint if a signal-only runtime still exists; never coerce it to
-- paper and accidentally make it executable.

PRAGMA foreign_keys=OFF;
CREATE TABLE strategy_runtime_old (
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
INSERT INTO strategy_runtime_old SELECT * FROM strategy_runtime;
DROP TABLE strategy_runtime;
ALTER TABLE strategy_runtime_old RENAME TO strategy_runtime;
CREATE INDEX IF NOT EXISTS idx_strategy_runtime_status ON strategy_runtime(status);
PRAGMA foreign_keys=ON;
