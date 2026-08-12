-- 基因进化不再仅以 Sharpe 排序：保留完整绩效评估和通过准入门槛后的多目标适应度。
ALTER TABLE `gene_generation` ADD COLUMN `best_fitness` REAL;
--> statement-breakpoint
ALTER TABLE `strategy_genome` ADD COLUMN `fitness_score` REAL;
--> statement-breakpoint
ALTER TABLE `strategy_genome` ADD COLUMN `evaluation_json` TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_strategy_genome_generation_fitness`
  ON `strategy_genome` (`generation_id`, `fitness_score` DESC);
