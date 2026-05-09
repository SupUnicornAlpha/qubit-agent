-- M8 execution confirmation ticket persistence
CREATE TABLE IF NOT EXISTS execution_confirm_ticket (
  id TEXT PRIMARY KEY,
  intent_order_id TEXT NOT NULL REFERENCES intent_order(id),
  confirm_token_hash TEXT NOT NULL,
  issued_by TEXT NOT NULL DEFAULT 'system',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expired','consumed','revoked')),
  risk_score_snapshot REAL NOT NULL,
  blockers_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_exec_ticket_intent ON execution_confirm_ticket(intent_order_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_exec_ticket_token_status ON execution_confirm_ticket(confirm_token_hash, status);
