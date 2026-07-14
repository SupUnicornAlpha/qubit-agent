DROP INDEX IF EXISTS `idx_recommendation_snapshot_project_status_asof`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `engine_version`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `evaluation_error`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `bars_observed`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `ambiguous_bar`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `take_profit_triggered`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `stop_loss_triggered`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `max_adverse_excursion_pct`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `max_favorable_excursion_pct`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `exit_reason`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `exit_price`;
--> statement-breakpoint
ALTER TABLE `recommendation_outcome` DROP COLUMN `entry_price`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `engine_version`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `data_asof`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `expires_at`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `status`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `benchmark_symbol`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `watch_conditions_json`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `invalidation_json`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `risk_reward_ratio`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `position_size_pct`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `take_profit`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `stop_loss`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `entry_high`;
--> statement-breakpoint
ALTER TABLE `recommendation_snapshot` DROP COLUMN `entry_low`;
