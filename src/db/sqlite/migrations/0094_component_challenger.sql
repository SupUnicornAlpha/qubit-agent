CREATE TABLE `component_eval_run` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `workflow_run_id` text,
  `component_kind` text NOT NULL,
  `component_id` text NOT NULL,
  `version_id` text NOT NULL,
  `eval_kind` text NOT NULL,
  `sample_size` integer DEFAULT 0 NOT NULL,
  `metrics_json` text DEFAULT '{}' NOT NULL,
  `quality_score` real NOT NULL,
  `pass` integer DEFAULT false NOT NULL,
  `created_by` text DEFAULT 'system' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (`workflow_run_id`) REFERENCES `workflow_run`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_component_eval_project_component` ON `component_eval_run` (`project_id`,`component_kind`,`component_id`,`created_at`);
