CREATE TABLE IF NOT EXISTS execution_mark_price (
  id TEXT PRIMARY KEY NOT NULL,
  market TEXT NOT NULL,
  symbol TEXT NOT NULL,
  price REAL NOT NULL CHECK(price > 0),
  observed_at TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1m',
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_execution_mark_market_symbol
  ON execution_mark_price(market, symbol);
--> statement-breakpoint
CREATE INDEX idx_execution_mark_freshness ON execution_mark_price(fetched_at);
