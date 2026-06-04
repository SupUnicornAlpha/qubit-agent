-- Roll back 0075_exec_call_log
DROP INDEX IF EXISTS `idx_exec_call_log_agent_def_created`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_exec_call_log_status_created`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_exec_call_log_provider_created`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_exec_call_log_workflow_created`;
--> statement-breakpoint
DROP TABLE IF EXISTS `exec_call_log`;
