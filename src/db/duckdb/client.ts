import { DuckDBInstance } from "@duckdb/node-api";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

let _instance: DuckDBInstance | null = null;

function getDbPath(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? ".";
  return `${home}/.quant-agent/db/analytics.duckdb`;
}

export async function getDuckDb(): Promise<DuckDBInstance> {
  if (_instance) return _instance;

  const dbPath = getDbPath();
  await mkdir(dirname(dbPath), { recursive: true });

  _instance = await DuckDBInstance.create(dbPath);
  await initAnalyticsTables(_instance);
  return _instance;
}

async function initAnalyticsTables(instance: DuckDBInstance): Promise<void> {
  const conn = await instance.connect();

  // metric_timeseries — high write frequency, no FK constraints
  await conn.run(`
    CREATE TABLE IF NOT EXISTS metric_timeseries (
      id          VARCHAR PRIMARY KEY,
      scope_type  VARCHAR NOT NULL,
      scope_id    VARCHAR NOT NULL,
      metric_name VARCHAR NOT NULL,
      metric_value DOUBLE NOT NULL,
      timestamp   TIMESTAMPTZ NOT NULL
    );
  `);

  // position_snapshot — time-series snapshots
  await conn.run(`
    CREATE TABLE IF NOT EXISTS position_snapshot (
      id            VARCHAR PRIMARY KEY,
      account_id    VARCHAR NOT NULL,
      instrument_id VARCHAR NOT NULL,
      qty           DOUBLE NOT NULL,
      avg_price     DOUBLE NOT NULL,
      mtm_pnl       DOUBLE NOT NULL,
      snapshot_time TIMESTAMPTZ NOT NULL
    );
  `);

  // backtest_results — detailed equity curves stored as Parquet references
  await conn.run(`
    CREATE TABLE IF NOT EXISTS backtest_result_meta (
      backtest_run_id VARCHAR PRIMARY KEY,
      parquet_uri     VARCHAR NOT NULL,
      created_at      TIMESTAMPTZ NOT NULL
    );
  `);

  conn.close();
}

export async function closeDuckDb(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}

/**
 * Execute an analytical query and return rows as plain objects.
 */
export async function queryAnalytics<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const instance = await getDuckDb();
  const conn = await instance.connect();
  try {
    const prepared = await conn.prepare(sql);
    for (let i = 0; i < params.length; i++) {
      // DuckDB node-api uses 1-based parameter binding
      prepared.bindVarchar(i + 1, String(params[i]));
    }
    const result = await prepared.run();
    const rows: T[] = [];
    const reader = await result.fetchAllRows();
    for (const row of reader) {
      rows.push(row as T);
    }
    return rows;
  } finally {
    conn.close();
  }
}
