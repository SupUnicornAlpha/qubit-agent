-- Persist auditable HAC / significance evidence alongside factor-evaluation aggregates.
ALTER TABLE factor_evaluation ADD COLUMN statistical_report_json TEXT;
