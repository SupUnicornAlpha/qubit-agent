/**
 * Unit tests — scripts/repair-migration-0080.ts
 *
 * 用 in-memory SQLite 模拟「0080 部分生效」的现网状态：
 *   - factor_definition 只有原始列 + 0080 第一句加的 created_by
 *   - strategy_composition 只有原始列（一句 0080 列都没加）
 *
 * 验证：
 *   1. 第一次 run 把缺失列 + 索引补齐
 *   2. 重复 run 是幂等的（columnsAdded=0 / columnsSkipped 全数）
 *   3. dry-run 模式不真写、但 plan 数量正确
 */

import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { repairMigration0080 } from "../repair-migration-0080";

/** 构建一个完整 schema 之外、仅含 0080 涉及表的 SQLite 实例。 */
function buildBaselineDb(): Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE factor_definition (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      workflow_run_id TEXT,
      created_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE rule_definition (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE discovery_job (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      workflow_run_id TEXT
    );
    CREATE TABLE strategy_version (
      id TEXT PRIMARY KEY NOT NULL,
      strategy_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE strategy_composition (
      id TEXT PRIMARY KEY NOT NULL,
      strategy_version_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'factor_score',
      factor_ids_json TEXT NOT NULL DEFAULT '[]',
      rule_ids_json TEXT NOT NULL DEFAULT '[]',
      weight_method TEXT NOT NULL DEFAULT 'equal',
      rebalance_freq TEXT NOT NULL DEFAULT '1d',
      universe TEXT NOT NULL DEFAULT 'CN-A',
      params_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE backtest_run (
      id TEXT PRIMARY KEY NOT NULL,
      strategy_version_id TEXT NOT NULL,
      agent_instance_id TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
  return sqlite;
}

function pragmaCols(sqlite: Database, table: string): Set<string> {
  const rows = sqlite
    .query<{ name: string }, []>(`PRAGMA table_info(\`${table}\`)`)
    .all();
  return new Set(rows.map((r) => r.name));
}

function listIndexNames(sqlite: Database): Set<string> {
  const rows = sqlite
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='index'`)
    .all();
  return new Set(rows.map((r) => r.name));
}

describe("repairMigration0080", () => {
  it("把 strategy_composition 的所有 0080 列都补齐（核心场景）", () => {
    const sqlite = buildBaselineDb();
    const report = repairMigration0080(sqlite, { dryRun: false, verbose: false });

    const cols = pragmaCols(sqlite, "strategy_composition");
    expect(cols.has("name")).toBe(true);
    expect(cols.has("description")).toBe(true);
    expect(cols.has("created_by")).toBe(true);
    expect(cols.has("workflow_run_id")).toBe(true);
    expect(cols.has("agent_instance_id")).toBe(true);
    expect(cols.has("parent_composition_id")).toBe(true);

    // 现网状态：factor_definition.created_by 已存在 → 应该 skip
    expect(report.columnsSkipped).toBeGreaterThan(0);
    expect(report.columnsAdded).toBeGreaterThan(0);
  });

  it("现网现状中已存在的列要 skip（factor_definition.created_by）", () => {
    const sqlite = buildBaselineDb();
    const report = repairMigration0080(sqlite, { dryRun: false, verbose: false });
    // baseline 里 factor_definition.created_by 提前 ALTER 加好了 → 必然 skip 1 次
    expect(report.columnsSkipped).toBeGreaterThanOrEqual(1);
  });

  it("重复运行是幂等的（第二次 columnsAdded=0）", () => {
    const sqlite = buildBaselineDb();
    repairMigration0080(sqlite, { dryRun: false, verbose: false });
    const second = repairMigration0080(sqlite, { dryRun: false, verbose: false });
    expect(second.columnsAdded).toBe(0);
    expect(second.indexesAdded).toBe(0);
    expect(second.plan.length).toBe(0);
  });

  it("dry-run 不真写但 plan 非空", () => {
    const sqlite = buildBaselineDb();
    const report = repairMigration0080(sqlite, { dryRun: true, verbose: false });
    expect(report.columnsAdded).toBe(0); // dry-run 不计入 added
    expect(report.plan.length).toBeGreaterThan(0);
    // dry-run 后表里仍然没有 name 列
    const cols = pragmaCols(sqlite, "strategy_composition");
    expect(cols.has("name")).toBe(false);
  });

  it("所有 0080 索引都建成", () => {
    const sqlite = buildBaselineDb();
    repairMigration0080(sqlite, { dryRun: false, verbose: false });
    const idx = listIndexNames(sqlite);
    expect(idx.has("idx_strategy_composition_workflow")).toBe(true);
    expect(idx.has("idx_strategy_composition_created_by")).toBe(true);
    expect(idx.has("idx_backtest_run_workflow")).toBe(true);
    expect(idx.has("idx_factor_definition_source_job")).toBe(true);
  });
});
