CREATE TABLE `communication_channel` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`secret_ref` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `communication_message_log` (
	`id` text PRIMARY KEY NOT NULL,
	`direction` text NOT NULL,
	`channel_kind` text NOT NULL,
	`external_chat_id` text NOT NULL,
	`external_message_id` text,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
