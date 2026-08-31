DROP INDEX IF EXISTS `idx_component_eval_project_component_cohort`;
--> statement-breakpoint
ALTER TABLE `component_eval_run` DROP COLUMN `comparison_cohort_id`;
