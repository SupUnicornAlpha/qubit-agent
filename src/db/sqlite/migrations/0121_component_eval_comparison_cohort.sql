ALTER TABLE `component_eval_run`
  ADD COLUMN `comparison_cohort_id` TEXT;
--> statement-breakpoint
CREATE INDEX `idx_component_eval_project_component_cohort`
  ON `component_eval_run` (`project_id`,`component_kind`,`component_id`,`comparison_cohort_id`,`created_at`);
