ALTER TABLE `recommendation_outcome`
  ADD COLUMN `market_data_evidence_json` TEXT NOT NULL DEFAULT '{}';
