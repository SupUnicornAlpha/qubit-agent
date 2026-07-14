ALTER TABLE order_intent ADD COLUMN trigger_direction TEXT CHECK(trigger_direction IN ('above','below'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_order_intent_trigger_direction
  ON order_intent(activation_status, trigger_direction, symbol);
