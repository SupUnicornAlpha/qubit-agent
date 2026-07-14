ALTER TABLE order_intent ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'created';
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN client_order_id TEXT;
--> statement-breakpoint
ALTER TABLE order_intent ADD COLUMN lifecycle_updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_intent_client_order_id
  ON order_intent(client_order_id)
  WHERE client_order_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_lifecycle
  ON order_intent(lifecycle_status, lifecycle_updated_at DESC);
--> statement-breakpoint
UPDATE order_intent
SET lifecycle_status = COALESCE(
  (
    SELECT CASE execution_task.status
      WHEN 'awaiting_review' THEN 'risk_checked'
      WHEN 'pending' THEN 'risk_checked'
      WHEN 'dispatching' THEN 'submitted'
      WHEN 'waiting_ack' THEN 'submitted'
      WHEN 'partially_filled' THEN 'partial'
      WHEN 'filled' THEN 'filled'
      WHEN 'cancelled' THEN 'cancelled'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'failed' THEN 'rejected'
      ELSE 'created'
    END
    FROM execution_task
    WHERE execution_task.order_intent_id = order_intent.id
    LIMIT 1
  ),
  'created'
);
