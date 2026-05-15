-- Unified execution: extend order_intent + execution_task for multi-market dispatch.

ALTER TABLE order_intent ADD COLUMN market TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN symbol TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN timeframe TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN strategy_runtime_id TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN signal_bar_time TEXT;
--> statement-breakpoint
ALTER TABLE execution_task ADD COLUMN broker_account_id TEXT REFERENCES broker_account(id);
--> statement-breakpoint
ALTER TABLE execution_task ADD COLUMN dispatch_mode TEXT NOT NULL DEFAULT 'paper' CHECK(dispatch_mode IN ('paper', 'live'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_strategy_runtime ON order_intent(strategy_runtime_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_signal_dedup ON order_intent(strategy_runtime_id, symbol, signal_bar_time);
