DROP INDEX IF EXISTS idx_factor_evaluation_snapshot;
--> statement-breakpoint
ALTER TABLE factor_evaluation DROP COLUMN dataset_snapshot_id;
