CREATE TABLE `a2a_message` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`sender_instance_id` text NOT NULL,
	`receiver_instance_id` text,
	`message_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`priority` integer DEFAULT 50 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receiver_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `acp_call` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`trace_id` text NOT NULL,
	`agent_step_id` text,
	`caller_instance_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_name` text NOT NULL,
	`intent` text NOT NULL,
	`input_schema_version` text DEFAULT '1.0' NOT NULL,
	`output_schema_version` text,
	`latency_ms` integer,
	`status` text NOT NULL,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`caller_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_definition` (
	`id` text PRIMARY KEY NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`system_prompt` text NOT NULL,
	`tools_json` text DEFAULT '[]' NOT NULL,
	`mcp_servers_json` text DEFAULT '[]' NOT NULL,
	`skills_json` text DEFAULT '[]' NOT NULL,
	`subscriptions_json` text DEFAULT '[]' NOT NULL,
	`llm_provider` text NOT NULL,
	`max_iterations` integer DEFAULT 20 NOT NULL,
	`sandbox_policy_id` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`sandbox_policy_id`) REFERENCES `sandbox_policy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_instance` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_iteration` integer DEFAULT 0 NOT NULL,
	`started_at` text,
	`ended_at` text,
	`error_message` text,
	FOREIGN KEY (`definition_id`) REFERENCES `agent_definition`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `agent_step` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_instance_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`step_index` integer NOT NULL,
	`phase` text NOT NULL,
	`thought` text,
	`action_type` text NOT NULL,
	`action_json` text NOT NULL,
	`observation_json` text,
	`token_count` integer,
	`latency_ms` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`workflow_run_id` text,
	`agent_instance_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`detail_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `backtest_run` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_version_id` text NOT NULL,
	`agent_instance_id` text,
	`connector_instance_id` text NOT NULL,
	`dataset_snapshot_id` text NOT NULL,
	`config_json` text NOT NULL,
	`performance_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`strategy_version_id`) REFERENCES `strategy_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `broker_order` (
	`id` text PRIMARY KEY NOT NULL,
	`order_intent_id` text NOT NULL,
	`account_id` text NOT NULL,
	`connector_instance_id` text NOT NULL,
	`broker_order_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`order_intent_id`) REFERENCES `order_intent`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `trading_account`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connector_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`connector_instance_id` text NOT NULL,
	`acp_call_id` text,
	`trace_id` text NOT NULL,
	`operation` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`latency_ms` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acp_call_id`) REFERENCES `acp_call`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connector_instance` (
	`id` text PRIMARY KEY NOT NULL,
	`spec_id` text NOT NULL,
	`env` text DEFAULT 'dev' NOT NULL,
	`config_ref` text NOT NULL,
	`status` text DEFAULT 'inactive' NOT NULL,
	`last_healthcheck_at` text,
	FOREIGN KEY (`spec_id`) REFERENCES `connector_spec`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `connector_spec` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`connector_type` text NOT NULL,
	`version` text NOT NULL,
	`capabilities_json` text NOT NULL,
	`asset_classes_json` text NOT NULL,
	`latency_profile` text NOT NULL,
	`schema_contract_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dataset_snapshot` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source_id` text NOT NULL,
	`asof_time` text NOT NULL,
	`range_start` text NOT NULL,
	`range_end` text NOT NULL,
	`schema_version` text DEFAULT '1.0' NOT NULL,
	`location_uri` text NOT NULL,
	`quality_score` real,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `market_data_source`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `factor_definition` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`definition_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fill` (
	`id` text PRIMARY KEY NOT NULL,
	`broker_order_id` text NOT NULL,
	`fill_qty` real NOT NULL,
	`fill_price` real NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`broker_order_id`) REFERENCES `broker_order`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `instrument` (
	`id` text PRIMARY KEY NOT NULL,
	`symbol` text NOT NULL,
	`asset_class` text NOT NULL,
	`exchange` text NOT NULL,
	`meta_json` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `llm_provider_config` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`provider_type` text NOT NULL,
	`base_url` text,
	`model_name` text NOT NULL,
	`api_key_ref` text,
	`context_window` integer DEFAULT 128000 NOT NULL,
	`supports_function_calling` integer DEFAULT true NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `longterm_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`scope_id` text NOT NULL,
	`memory_type` text NOT NULL,
	`content_json` text NOT NULL,
	`embedding_ref` text,
	`artifact_uri` text,
	`valid_from` text NOT NULL,
	`valid_to` text,
	`asof_time` text NOT NULL,
	`confidence_score` real,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `market_data_source` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`source_type` text NOT NULL,
	`vendor` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mcp_server_config` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`transport` text NOT NULL,
	`command` text,
	`url` text,
	`capabilities_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_backend_config` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`connector_type` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`write_mode` text DEFAULT 'native_only' NOT NULL,
	`connector_instance_id` text,
	`config_ref` text DEFAULT '' NOT NULL,
	`fallback_to_native` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`connector_instance_id`) REFERENCES `connector_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory_link` (
	`id` text PRIMARY KEY NOT NULL,
	`from_type` text NOT NULL,
	`from_id` text NOT NULL,
	`to_type` text NOT NULL,
	`to_id` text NOT NULL,
	`relation` text NOT NULL,
	`weight` real DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_sync_log` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_backend_config_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer,
	`error_detail` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`memory_backend_config_id`) REFERENCES `memory_backend_config`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `midterm_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`memory_type` text NOT NULL,
	`content_json` text NOT NULL,
	`time_window_start` text NOT NULL,
	`time_window_end` text NOT NULL,
	`asof_time` text NOT NULL,
	`score` real,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `news_event` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`instrument_id` text,
	`published_at` text NOT NULL,
	`event_type` text NOT NULL,
	`sentiment_score` real,
	`content_ref` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `market_data_source`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instrument_id`) REFERENCES `instrument`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `order_intent` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`strategy_version_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`side` text NOT NULL,
	`qty` real NOT NULL,
	`order_type` text NOT NULL,
	`price` real,
	`time_in_force` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`strategy_version_id`) REFERENCES `strategy_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instrument_id`) REFERENCES `instrument`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`market_scope` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `research_experiment` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_version_id` text NOT NULL,
	`agent_instance_id` text,
	`dataset_snapshot_id` text NOT NULL,
	`metric_json` text NOT NULL,
	`result_summary` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`strategy_version_id`) REFERENCES `strategy_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `risk_decision` (
	`id` text PRIMARY KEY NOT NULL,
	`order_intent_id` text NOT NULL,
	`risk_rule_id` text NOT NULL,
	`agent_instance_id` text,
	`decision` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`signature` text NOT NULL,
	FOREIGN KEY (`order_intent_id`) REFERENCES `order_intent`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`risk_rule_id`) REFERENCES `risk_rule`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `risk_rule` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`scope` text NOT NULL,
	`rule_expr` text NOT NULL,
	`severity` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sandbox_policy` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`allowed_tools_json` text DEFAULT '[]' NOT NULL,
	`allowed_mcp_servers_json` text DEFAULT '[]' NOT NULL,
	`allowed_connectors_json` text DEFAULT '[]' NOT NULL,
	`allowed_hosts_json` text DEFAULT '[]' NOT NULL,
	`allowed_fs_paths_json` text DEFAULT '[]' NOT NULL,
	`can_write_memory` integer DEFAULT true NOT NULL,
	`can_read_live_market` integer DEFAULT false NOT NULL,
	`can_submit_order` integer DEFAULT false NOT NULL,
	`max_tool_call_ms` integer DEFAULT 30000 NOT NULL,
	`max_iterations_per_run` integer DEFAULT 20 NOT NULL,
	`max_output_tokens` integer DEFAULT 4096 NOT NULL,
	`isolation_level` text DEFAULT 'none' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sandbox_violation_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_instance_id` text NOT NULL,
	`workflow_run_id` text NOT NULL,
	`violation_type` text NOT NULL,
	`attempted_action` text NOT NULL,
	`sandbox_policy_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sandbox_policy_id`) REFERENCES `sandbox_policy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `session_memory` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_run_id` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`state_json` text NOT NULL,
	`asof_time` text NOT NULL,
	`ttl_at` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_memory_workflow_idx` ON `session_memory` (`workflow_run_id`);--> statement-breakpoint
CREATE TABLE `simulation_run` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_version_id` text NOT NULL,
	`agent_instance_id` text,
	`connector_instance_id` text NOT NULL,
	`paper_account_id` text NOT NULL,
	`performance_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`strategy_version_id`) REFERENCES `strategy_version`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategy` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`style` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`owner_instance_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_instance_id`) REFERENCES `agent_instance`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `strategy_version` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`version_tag` text NOT NULL,
	`logic_hash` text NOT NULL,
	`param_schema_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `strategy`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tool_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_step_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`tool_kind` text NOT NULL,
	`request_json` text NOT NULL,
	`response_json` text,
	`status` text NOT NULL,
	`latency_ms` integer,
	`error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`agent_step_id`) REFERENCES `agent_step`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trading_account` (
	`id` text PRIMARY KEY NOT NULL,
	`broker` text NOT NULL,
	`market_scope` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_run` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`session_id` text,
	`goal` text NOT NULL,
	`mode` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
