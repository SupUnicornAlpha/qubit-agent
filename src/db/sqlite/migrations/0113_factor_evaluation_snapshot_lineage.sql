-- Quant Research Integrity M1: every reproducible factor evaluation references
-- the immutable dataset snapshot used for factor values and future returns.
-- NULL is retained only for legacy/manual unversioned evaluations.
ALTER TABLE factor_evaluation ADD COLUMN dataset_snapshot_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_factor_evaluation_snapshot
  ON factor_evaluation (dataset_snapshot_id, factor_id, asof DESC);
