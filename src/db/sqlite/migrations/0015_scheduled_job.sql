CREATE TABLE IF NOT EXISTS `scheduled_job` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`cron_expr` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`execution_mode` text DEFAULT 'paper' NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `chat_session`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_job_enabled_next_run` ON `scheduled_job` (`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `scheduled_job_run` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`trigger_at` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`workflow_run_id` text,
	`intent_order_id` text,
	`execution_report_id` text,
	`error_message` text,
	`started_at` text,
	`ended_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `scheduled_job`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`intent_order_id`) REFERENCES `intent_order`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`execution_report_id`) REFERENCES `execution_report`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_scheduled_job_run_job_trigger_unique` ON `scheduled_job_run` (`job_id`,`trigger_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_job_run_job_created` ON `scheduled_job_run` (`job_id`,`created_at`);
