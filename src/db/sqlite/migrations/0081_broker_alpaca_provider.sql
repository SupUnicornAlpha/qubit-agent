-- 0081_broker_alpaca_provider — broker_account / broker_order_event 的 provider CHECK 扩到 4 个
--
-- 背景：
--   1. 0014 建表时 CHECK(provider IN ('futu','ib'))，但后来代码已经支持 'ccxt'
--      （`src/runtime/reia/broker-connector.ts:MockCcxtConnector`、Python `ccxt_adapter.py`），
--      CHECK 约束一直没补，导致 seed `broker_account.provider='ccxt'` 会被拒。
--   2. 本次新增 Alpaca paper trading 支持（`docs/superpowers/specs/2026-06-09-paper-trading-data-flywheel.md`），
--      adapter 在 `python_connectors/connectors/broker_gateway/alpaca.py`、
--      TS 侧 `MockAlpacaConnector` 已加。
--
-- 改造：
--   - 改 broker_account.provider 的 CHECK 到 IN ('futu','ib','ccxt','alpaca')
--   - 改 broker_order_event.provider 的 CHECK 同上
--
-- SQLite 不支持 ALTER ... CHECK，必须重建表。
-- 已存数据全量迁移到新表，索引重建。

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE broker_account_new (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('futu','ib','ccxt','alpaca')),
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
  provider TEXT NOT NULL CHECK(provider IN ('futu','ib','ccxt','alpaca')),
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
