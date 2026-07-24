-- 0096_broker_cn_providers — add Tonghuashun SuperMind and Eastmoney EMT providers.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE broker_account_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('futu','ib','ccxt','alpaca','supermind','eastmoney_emt')),
  account_ref TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'mock' CHECK(mode IN ('mock','sandbox','live')),
  base_url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  health_status TEXT NOT NULL DEFAULT 'unknown' CHECK(health_status IN ('unknown','healthy','degraded','down')),
  health_message TEXT,
  last_health_at TEXT,
  provider_config_json TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
INSERT INTO broker_account_new SELECT
  id, provider, account_ref, mode, base_url, enabled, health_status, health_message,
  last_health_at, provider_config_json, is_default, created_at, updated_at
FROM broker_account;
--> statement-breakpoint
DROP TABLE broker_account;
--> statement-breakpoint
ALTER TABLE broker_account_new RENAME TO broker_account;
--> statement-breakpoint
CREATE INDEX idx_broker_account_provider_enabled ON broker_account(provider, enabled);
--> statement-breakpoint
CREATE TABLE broker_order_event_new (
  id TEXT PRIMARY KEY,
  intent_order_id TEXT REFERENCES intent_order(id),
  execution_report_id TEXT REFERENCES execution_report(id),
  provider TEXT NOT NULL CHECK(provider IN ('futu','ib','ccxt','alpaca','supermind','eastmoney_emt')),
  event_type TEXT NOT NULL CHECK(event_type IN ('submit','ack','partial_fill','fill','cancel','reject','health_check')),
  broker_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  detail_json TEXT NOT NULL DEFAULT '{}',
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
INSERT INTO broker_order_event_new SELECT
  id, intent_order_id, execution_report_id, provider, event_type, broker_order_id, status,
  detail_json, event_at, created_at
FROM broker_order_event;
--> statement-breakpoint
DROP TABLE broker_order_event;
--> statement-breakpoint
ALTER TABLE broker_order_event_new RENAME TO broker_order_event;
--> statement-breakpoint
CREATE INDEX idx_broker_order_event_intent_created ON broker_order_event(intent_order_id, created_at DESC);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
