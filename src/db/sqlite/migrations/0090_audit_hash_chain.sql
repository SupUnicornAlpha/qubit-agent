ALTER TABLE audit_log ADD COLUMN previous_hash text;
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN entry_hash text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_entry_hash_unique
  ON audit_log(entry_hash)
  WHERE entry_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_audit_log_workflow_created
  ON audit_log(workflow_run_id, created_at);
