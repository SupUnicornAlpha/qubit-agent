ALTER TABLE `workflow_run` ADD `source` text DEFAULT 'manual' NOT NULL;

CREATE TABLE `chat_session` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_activity_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`sender` text DEFAULT 'user' NOT NULL,
	`content` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`error_message` text,
	`token_count` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `chat_session`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `chat_message_workflow_link` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_message_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`chat_message_id`) REFERENCES `chat_message`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX `idx_chat_msg_workflow_unique` ON `chat_message_workflow_link` (`chat_message_id`,`workflow_run_id`);

CREATE TABLE `agent_profile` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`display_name` text NOT NULL,
	`soul_file_ref` text DEFAULT '' NOT NULL,
	`prompt_template_ref` text,
	`description` text DEFAULT '' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `agent_definition`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_definition_draft` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`version_tag` text NOT NULL,
	`system_prompt` text NOT NULL,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`mcp_servers_json` text DEFAULT '[]' NOT NULL,
	`skills_json` text DEFAULT '[]' NOT NULL,
	`subscriptions_json` text DEFAULT '[]' NOT NULL,
	`llm_provider` text NOT NULL,
	`max_iterations` integer DEFAULT 20 NOT NULL,
	`sandbox_policy_id` text NOT NULL,
	`change_note` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `agent_definition`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sandbox_policy_id`) REFERENCES `sandbox_policy`(`id`) ON UPDATE no action ON DELETE no action
);

CREATE TABLE `agent_definition_release` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`released_version` text NOT NULL,
	`release_note` text DEFAULT '' NOT NULL,
	`released_by` text DEFAULT 'user' NOT NULL,
	`released_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`definition_id`) REFERENCES `agent_definition`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`draft_id`) REFERENCES `agent_definition_draft`(`id`) ON UPDATE no action ON DELETE no action
);
