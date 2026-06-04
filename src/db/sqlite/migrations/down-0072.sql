-- Rollback for 0072_restore_connector_call_log.sql
DROP INDEX IF EXISTS `idx_connector_call_log_instance_created`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_connector_call_log_workflow_created`;
--> statement-breakpoint
DROP TABLE IF EXISTS `connector_call_log`;
