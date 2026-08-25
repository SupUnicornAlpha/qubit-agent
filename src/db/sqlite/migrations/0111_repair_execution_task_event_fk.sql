-- Repair child FK left pointing at the temporary rebuild table by historical
-- execution_task migrations.  SQLite may retain `execution_task_new` in the
-- child definition when foreign_keys was disabled during the parent rename.
-- Rebuild the child against the final parent name for fresh and existing DBs.

PRAGMA foreign_keys=OFF;
--> statement-breakpoint
CREATE TABLE execution_task_event_fk_repair (
  id TEXT PRIMARY KEY NOT NULL,
  execution_task_id TEXT NOT NULL REFERENCES execution_task(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'dispatch','trigger','activate','ack','partial_fill','fill','cancel','reject','timeout','retry'
  )),
  event_payload_json TEXT NOT NULL DEFAULT '{}',
  event_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
INSERT INTO execution_task_event_fk_repair
  SELECT id, execution_task_id, event_type, event_payload_json, event_at, created_at
  FROM execution_task_event;
--> statement-breakpoint
DROP TABLE execution_task_event;
--> statement-breakpoint
ALTER TABLE execution_task_event_fk_repair RENAME TO execution_task_event;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_execution_task_event_task_time
  ON execution_task_event(execution_task_id, event_at);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
