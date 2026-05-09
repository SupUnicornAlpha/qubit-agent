-- V2 Strategy Gene Pool
CREATE TABLE IF NOT EXISTS gene_generation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  generation_number INTEGER NOT NULL,
  population_size INTEGER NOT NULL,
  mutation_rate REAL NOT NULL DEFAULT 0.1,
  best_sharpe REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS strategy_gene (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  gene_type TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS strategy_genome (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  generation_id TEXT NOT NULL REFERENCES gene_generation(id),
  name TEXT NOT NULL,
  genes_snapshot_json TEXT NOT NULL DEFAULT '{}',
  sharpe_ratio REAL,
  max_drawdown REAL,
  total_return REAL,
  backtest_run_id TEXT REFERENCES backtest_run(id),
  parent_a_id TEXT,
  parent_b_id TEXT,
  mutation_log TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_gene_generation_project ON gene_generation(project_id, generation_number DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_strategy_genome_generation ON strategy_genome(generation_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_strategy_genome_project_active ON strategy_genome(project_id, is_active);
