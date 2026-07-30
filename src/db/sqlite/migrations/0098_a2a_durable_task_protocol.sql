-- Internal A2A transport is local, but its durable task model follows the A2A
-- protocol's Task + ordered status/artifact update semantics.
CREATE TABLE `a2a_task` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`context_id` text NOT NULL,
	`parent_task_id` text,
	`trace_id` text NOT NULL,
	`sender_agent_id` text NOT NULL,
	`receiver_agent_id` text NOT NULL,
	`receiver_role` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`input_json` text DEFAULT '{}' NOT NULL,
	`result_json` text,
	`error_json` text,
	`deadline_at` text,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_a2a_task_workflow_created` ON `a2a_task` (`workflow_run_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_a2a_task_receiver_status` ON `a2a_task` (`receiver_agent_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_a2a_task_workflow_idempotency` ON `a2a_task` (`workflow_run_id`,`idempotency_key`);
--> statement-breakpoint
CREATE TABLE `a2a_task_event` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `a2a_task`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_a2a_task_event_sequence` ON `a2a_task_event` (`task_id`,`sequence`);
--> statement-breakpoint
CREATE INDEX `idx_a2a_task_event_task_sequence` ON `a2a_task_event` (`task_id`,`sequence`);
