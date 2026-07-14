DROP INDEX IF EXISTS idx_order_intent_lifecycle;
DROP INDEX IF EXISTS idx_order_intent_client_order_id;
ALTER TABLE order_intent DROP COLUMN lifecycle_updated_at;
ALTER TABLE order_intent DROP COLUMN client_order_id;
ALTER TABLE order_intent DROP COLUMN lifecycle_status;
