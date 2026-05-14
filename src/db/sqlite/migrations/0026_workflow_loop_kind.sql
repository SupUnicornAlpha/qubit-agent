ALTER TABLE `workflow_run` ADD `loop_kind` text DEFAULT 'native' NOT NULL;
--> statement-breakpoint
ALTER TABLE `workflow_run` ADD `loop_options_json` text DEFAULT '{}' NOT NULL;
