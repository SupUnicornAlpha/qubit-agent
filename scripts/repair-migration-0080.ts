#!/usr/bin/env bun
/**
 * Repair migration 0080 — 量化产物 lineage 列补刀脚本。
 *
 * 背景（2026-06-09 现网踩坑）：
 *   `0080_quant_lineage.sql` 包含 30+ ALTER TABLE / CREATE INDEX statement，
 *   每条都用 `--> statement-breakpoint` 分隔。理论上 drizzle bun-sqlite migrator
 *   应该逐条 exec，但**实际上每个表的第 1 条 ALTER 跑过、之后所有句被静默跳过**，
 *   而 `__drizzle_migrations` 仍把 0080 标记为 applied —— 与 0055/0077 的多语句
 *   静默跳过故障同源（详见 `src/db/sqlite/migrate.ts` 头部注释）。
 *
 *   直接后果：
 *     - strategy_composition 缺 `name` 列 → agent 调 `strategy.compose` 100% 失败
 *     - factor_definition 缺 `agent_instance_id` / `source_job_id` → agent 产因子无 lineage
 *     - rule_definition / backtest_run 缺 lineage 列同理
 *     - 多个 idx_* 索引未建
 *
 * 修复策略：
 *   - 完全幂等：每个 ALTER 前 PRAGMA table_info 检测列是否已存在、跳过即可
 *   - CREATE INDEX IF NOT EXISTS 天然幂等
 *   - 不动 `__drizzle_migrations`（保留 80/80 状态、防止 drift check 误报）
 *   - 不动 dev server，直接连同一 SQLite（dev server 会通过 busy_timeout 等锁）
 *
 * 使用：
 *   QUBIT_DATA_DIR="$HOME/Library/Application Support/app.qubit.agent" bun run scripts/repair-migration-0080.ts
 *
 *   --dry-run  仅打印 plan、不执行
 *   --verbose  打印每个 statement 的 before/after
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

interface ColumnSpec {
  table: string;
  column: string;
  ddl: string;
}

interface IndexSpec {
  name: string;
  ddl: string;
}

/**
 * 0080 期望补齐的列列表。完全镜像 `0080_quant_lineage.sql`。
 * 每条独立 ALTER；不依赖其它列存在与否。
 */
const COLUMNS: ColumnSpec[] = [
  // factor_definition
  {
    table: "factor_definition",
    column: "created_by",
    ddl: "ALTER TABLE `factor_definition` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user'",
  },
  {
    table: "factor_definition",
    column: "agent_instance_id",
    ddl: "ALTER TABLE `factor_definition` ADD COLUMN `agent_instance_id` TEXT",
  },
  {
    table: "factor_definition",
    column: "source_job_id",
    ddl: "ALTER TABLE `factor_definition` ADD COLUMN `source_job_id` TEXT",
  },

  // rule_definition
  {
    table: "rule_definition",
    column: "created_by",
    ddl: "ALTER TABLE `rule_definition` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user'",
  },
  {
    table: "rule_definition",
    column: "workflow_run_id",
    ddl: "ALTER TABLE `rule_definition` ADD COLUMN `workflow_run_id` TEXT",
  },
  {
    table: "rule_definition",
    column: "agent_instance_id",
    ddl: "ALTER TABLE `rule_definition` ADD COLUMN `agent_instance_id` TEXT",
  },

  // discovery_job
  {
    table: "discovery_job",
    column: "created_by",
    ddl: "ALTER TABLE `discovery_job` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user'",
  },
  {
    table: "discovery_job",
    column: "agent_instance_id",
    ddl: "ALTER TABLE `discovery_job` ADD COLUMN `agent_instance_id` TEXT",
  },

  // strategy_composition（最关键 —— name 缺失导致 agent 写入 100% 失败）
  {
    table: "strategy_composition",
    column: "created_by",
    ddl: "ALTER TABLE `strategy_composition` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user'",
  },
  {
    table: "strategy_composition",
    column: "workflow_run_id",
    ddl: "ALTER TABLE `strategy_composition` ADD COLUMN `workflow_run_id` TEXT",
  },
  {
    table: "strategy_composition",
    column: "agent_instance_id",
    ddl: "ALTER TABLE `strategy_composition` ADD COLUMN `agent_instance_id` TEXT",
  },
  {
    table: "strategy_composition",
    column: "parent_composition_id",
    ddl: "ALTER TABLE `strategy_composition` ADD COLUMN `parent_composition_id` TEXT",
  },
  {
    table: "strategy_composition",
    column: "name",
    ddl: "ALTER TABLE `strategy_composition` ADD COLUMN `name` TEXT NOT NULL DEFAULT ''",
  },
  {
    table: "strategy_composition",
    column: "description",
    ddl: "ALTER TABLE `strategy_composition` ADD COLUMN `description` TEXT NOT NULL DEFAULT ''",
  },

  // backtest_run
  {
    table: "backtest_run",
    column: "created_by",
    ddl: "ALTER TABLE `backtest_run` ADD COLUMN `created_by` TEXT NOT NULL DEFAULT 'user'",
  },
  {
    table: "backtest_run",
    column: "workflow_run_id",
    ddl: "ALTER TABLE `backtest_run` ADD COLUMN `workflow_run_id` TEXT",
  },
  {
    table: "backtest_run",
    column: "composition_id",
    ddl: "ALTER TABLE `backtest_run` ADD COLUMN `composition_id` TEXT",
  },
];

const INDEXES: IndexSpec[] = [
  // factor_definition
  {
    name: "idx_factor_definition_created_by",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_factor_definition_created_by` ON `factor_definition` (`created_by`)",
  },
  {
    name: "idx_factor_definition_agent_instance",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_factor_definition_agent_instance` ON `factor_definition` (`agent_instance_id`)",
  },
  {
    name: "idx_factor_definition_source_job",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_factor_definition_source_job` ON `factor_definition` (`source_job_id`)",
  },
  // rule_definition
  {
    name: "idx_rule_definition_created_by",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_rule_definition_created_by` ON `rule_definition` (`created_by`)",
  },
  {
    name: "idx_rule_definition_workflow",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_rule_definition_workflow` ON `rule_definition` (`workflow_run_id`)",
  },
  {
    name: "idx_rule_definition_agent_instance",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_rule_definition_agent_instance` ON `rule_definition` (`agent_instance_id`)",
  },
  // discovery_job
  {
    name: "idx_discovery_job_created_by",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_discovery_job_created_by` ON `discovery_job` (`created_by`)",
  },
  {
    name: "idx_discovery_job_agent_instance",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_discovery_job_agent_instance` ON `discovery_job` (`agent_instance_id`)",
  },
  // strategy_composition
  {
    name: "idx_strategy_composition_created_by",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_strategy_composition_created_by` ON `strategy_composition` (`created_by`)",
  },
  {
    name: "idx_strategy_composition_workflow",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_strategy_composition_workflow` ON `strategy_composition` (`workflow_run_id`)",
  },
  {
    name: "idx_strategy_composition_agent_instance",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_strategy_composition_agent_instance` ON `strategy_composition` (`agent_instance_id`)",
  },
  {
    name: "idx_strategy_composition_parent",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_strategy_composition_parent` ON `strategy_composition` (`parent_composition_id`)",
  },
  // backtest_run
  {
    name: "idx_backtest_run_created_by",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_backtest_run_created_by` ON `backtest_run` (`created_by`)",
  },
  {
    name: "idx_backtest_run_workflow",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_backtest_run_workflow` ON `backtest_run` (`workflow_run_id`)",
  },
  {
    name: "idx_backtest_run_composition",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_backtest_run_composition` ON `backtest_run` (`composition_id`)",
  },
  {
    name: "idx_backtest_run_agent_instance",
    ddl: "CREATE INDEX IF NOT EXISTS `idx_backtest_run_agent_instance` ON `backtest_run` (`agent_instance_id`)",
  },
];

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
}

function listColumns(sqlite: Database, table: string): Set<string> {
  const rows = sqlite.query<ColumnInfo, []>(`PRAGMA table_info(\`${table}\`)`).all();
  return new Set(rows.map((r) => r.name));
}

function listIndexes(sqlite: Database): Set<string> {
  const rows = sqlite
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index'`)
    .all();
  return new Set(rows.map((r) => r.name));
}

interface RunOptions {
  dryRun: boolean;
  verbose: boolean;
}

interface RepairReport {
  columnsAdded: number;
  columnsSkipped: number;
  indexesAdded: number;
  indexesSkipped: number;
  /** 真正发出的 SQL（dry-run 时也填）*/
  plan: string[];
}

export function repairMigration0080(sqlite: Database, opts: RunOptions): RepairReport {
  const report: RepairReport = {
    columnsAdded: 0,
    columnsSkipped: 0,
    indexesAdded: 0,
    indexesSkipped: 0,
    plan: [],
  };

  // === 1. 补列 ===
  // 按 table group cache PRAGMA 结果减少 sqlite 调用
  const tableCols = new Map<string, Set<string>>();
  for (const spec of COLUMNS) {
    if (!tableCols.has(spec.table)) {
      tableCols.set(spec.table, listColumns(sqlite, spec.table));
    }
    const cols = tableCols.get(spec.table)!;
    if (cols.has(spec.column)) {
      report.columnsSkipped++;
      if (opts.verbose) {
        console.log(`  [skip] ${spec.table}.${spec.column} already exists`);
      }
      continue;
    }
    report.plan.push(spec.ddl);
    if (opts.dryRun) {
      console.log(`  [plan] ${spec.ddl}`);
    } else {
      sqlite.exec(spec.ddl);
      cols.add(spec.column);
      report.columnsAdded++;
      console.log(`  [done] ${spec.table}.${spec.column}`);
    }
  }

  // === 2. 补索引 ===
  const existingIdx = listIndexes(sqlite);
  for (const idx of INDEXES) {
    if (existingIdx.has(idx.name)) {
      report.indexesSkipped++;
      if (opts.verbose) {
        console.log(`  [skip] index ${idx.name} already exists`);
      }
      continue;
    }
    report.plan.push(idx.ddl);
    if (opts.dryRun) {
      console.log(`  [plan] ${idx.ddl}`);
    } else {
      sqlite.exec(idx.ddl);
      report.indexesAdded++;
      console.log(`  [done] index ${idx.name}`);
    }
  }

  return report;
}

function resolveDataDir(): string {
  const explicit = process.env.QUBIT_DATA_DIR;
  if (explicit) return explicit;
  return join(homedir(), "Library", "Application Support", "app.qubit.agent");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opts: RunOptions = {
    dryRun: args.includes("--dry-run"),
    verbose: args.includes("--verbose"),
  };

  const dbPath = join(resolveDataDir(), "db", "core.sqlite");
  if (!existsSync(dbPath)) {
    console.error(`[repair-0080] DB not found: ${dbPath}`);
    process.exit(1);
  }
  console.log(`[repair-0080] DB: ${dbPath}`);
  console.log(`[repair-0080] mode: ${opts.dryRun ? "dry-run" : "apply"}`);

  const sqlite = new Database(dbPath);
  // 用 busy_timeout 等 dev server 的写锁（不强求 dev server 关闭）
  sqlite.exec("PRAGMA busy_timeout=15000");
  sqlite.exec("PRAGMA foreign_keys=ON");

  try {
    const report = repairMigration0080(sqlite, opts);
    console.log("");
    console.log(`[repair-0080] columns: +${report.columnsAdded} added / ${report.columnsSkipped} already there`);
    console.log(`[repair-0080] indexes: +${report.indexesAdded} added / ${report.indexesSkipped} already there`);
    if (opts.dryRun && report.plan.length > 0) {
      console.log(`[repair-0080] dry-run plan ${report.plan.length} statement(s) — rerun without --dry-run to execute.`);
    }
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  await main();
}
