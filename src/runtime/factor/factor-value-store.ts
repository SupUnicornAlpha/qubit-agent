/**
 * FactorValueStore — 因子值时序存储（DuckDB）
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1 §4.3
 *
 * 为什么 DuckDB 而不是 SQLite：
 *   - 因子值表是 (factor_id × symbol × date) 笛卡尔积，行数容易上亿
 *   - 列存 + 向量化执行，聚合查询比 SQLite 快一两个数量级
 *   - 与 metric_timeseries / backtest_result_meta 同库，便于联合查询
 *
 * 表结构：
 *   factor_value(factor_id, symbol, date, value, created_at)
 *   PK = (factor_id, symbol, date) 由 upsert 保证去重
 */

import { getDuckDb } from "../../db/duckdb/client";
import type { FactorComputeRow } from "../provider/types";

const ENSURE = `
CREATE TABLE IF NOT EXISTS factor_value (
  factor_id   VARCHAR NOT NULL,
  symbol      VARCHAR NOT NULL,
  date        DATE NOT NULL,
  value       DOUBLE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (factor_id, symbol, date)
);
`;

const ENSURE_IDX_SYM = `
CREATE INDEX IF NOT EXISTS idx_factor_value_sym_date
  ON factor_value (symbol, date);
`;

let initPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  initPromise ??= (async () => {
    const inst = await getDuckDb();
    const conn = await inst.connect();
    try {
      await conn.run(ENSURE);
      await conn.run(ENSURE_IDX_SYM);
    } finally {
      conn.disconnectSync();
    }
  })();
  return initPromise;
}

export interface FactorValueWriteInput {
  factorId: string;
  rows: FactorComputeRow[];
}

export interface FactorValueQuery {
  factorId: string;
  symbols?: string[];
  startDate?: string;
  endDate?: string;
  /** 取最新 N 个交易日（与 startDate/endDate 互斥） */
  latestN?: number;
}

export interface FactorValueRow {
  factorId: string;
  symbol: string;
  date: string;
  value: number | null;
}

/** 把 ISO 时间戳归一到 YYYY-MM-DD（DuckDB DATE 类型只接受日期部分） */
function toDate(raw: string): string {
  return raw.length > 10 ? raw.slice(0, 10) : raw;
}

function escapeIdent(s: string): string {
  return s.replace(/'/g, "''");
}

export class FactorValueStore {
  /**
   * 批量写入；同 (factor_id, symbol, date) 已存在 → 更新 value
   *
   * DuckDB 支持 INSERT ... ON CONFLICT DO UPDATE（PG 风格）。
   * 这里用一次性 multi-row VALUES，避免单行 prepared 多次往返。
   */
  async upsert(input: FactorValueWriteInput): Promise<{ written: number }> {
    if (!input.rows.length) return { written: 0 };
    await ensureSchema();

    const inst = await getDuckDb();
    const conn = await inst.connect();
    try {
      // 用临时表 + UPSERT 模式，避免一次 INSERT VALUES 太长（DuckDB 上限是 1MB-ish）
      await conn.run(`CREATE TEMP TABLE IF NOT EXISTS _factor_value_stage (
        factor_id VARCHAR, symbol VARCHAR, date DATE, value DOUBLE
      );`);
      await conn.run(`DELETE FROM _factor_value_stage;`);

      // 分批 1000 行一次 INSERT
      const BATCH = 1000;
      const fid = escapeIdent(input.factorId);
      for (let off = 0; off < input.rows.length; off += BATCH) {
        const chunk = input.rows.slice(off, off + BATCH);
        const values = chunk
          .map((r) => {
            const sym = escapeIdent(r.symbol);
            const date = escapeIdent(toDate(r.date));
            const val = r.value == null || !Number.isFinite(r.value) ? "NULL" : String(r.value);
            return `('${fid}', '${sym}', DATE '${date}', ${val})`;
          })
          .join(", ");
        await conn.run(`INSERT INTO _factor_value_stage VALUES ${values};`);
      }

      const writtenSql = `
        INSERT INTO factor_value (factor_id, symbol, date, value)
        SELECT factor_id, symbol, date, value FROM _factor_value_stage
        ON CONFLICT (factor_id, symbol, date) DO UPDATE
          SET value = EXCLUDED.value, created_at = now();
      `;
      await conn.run(writtenSql);
      await conn.run(`DELETE FROM _factor_value_stage;`);

      return { written: input.rows.length };
    } finally {
      conn.disconnectSync();
    }
  }

  /** 区间或最新 N 条查询 */
  async query(q: FactorValueQuery): Promise<FactorValueRow[]> {
    await ensureSchema();
    const inst = await getDuckDb();
    const conn = await inst.connect();
    try {
      const wheres: string[] = [`factor_id = '${escapeIdent(q.factorId)}'`];
      if (q.symbols && q.symbols.length > 0) {
        const syms = q.symbols.map((s) => `'${escapeIdent(s)}'`).join(", ");
        wheres.push(`symbol IN (${syms})`);
      }
      if (q.startDate) wheres.push(`date >= DATE '${escapeIdent(toDate(q.startDate))}'`);
      if (q.endDate) wheres.push(`date <= DATE '${escapeIdent(toDate(q.endDate))}'`);

      let sql: string;
      if (q.latestN && q.latestN > 0 && !q.startDate && !q.endDate) {
        sql = `
          WITH ranked AS (
            SELECT factor_id, symbol, date, value,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
            FROM factor_value
            WHERE ${wheres.join(" AND ")}
          )
          SELECT factor_id, symbol, date, value FROM ranked WHERE rn <= ${Math.floor(q.latestN)}
          ORDER BY symbol, date;
        `;
      } else {
        sql = `
          SELECT factor_id, symbol, date, value
          FROM factor_value
          WHERE ${wheres.join(" AND ")}
          ORDER BY symbol, date;
        `;
      }

      const prepared = await conn.prepare(sql);
      const result = await prepared.run();
      const rows = await result.getRows();
      const out: FactorValueRow[] = [];
      for (const row of rows) {
        const tuple = row as unknown[];
        const dateRaw = tuple[2];
        out.push({
          factorId: String(tuple[0]),
          symbol: String(tuple[1]),
          date: this.dateToIso(dateRaw),
          value: this.toNumberOrNull(tuple[3]),
        });
      }
      return out;
    } finally {
      conn.disconnectSync();
    }
  }

  /** 取某日横截面（所有 symbol） */
  async queryAt(factorId: string, date: string): Promise<FactorValueRow[]> {
    return this.query({ factorId, startDate: date, endDate: date });
  }

  /** 删某因子的全部值（用于重算 / archived） */
  async deleteByFactor(factorId: string): Promise<{ deleted: number }> {
    await ensureSchema();
    const inst = await getDuckDb();
    const conn = await inst.connect();
    try {
      const sql = `DELETE FROM factor_value WHERE factor_id = '${escapeIdent(factorId)}';`;
      await conn.run(sql);
      // DuckDB delete 不直接返 rowcount；按写入时记录估算可后续补
      return { deleted: -1 };
    } finally {
      conn.disconnectSync();
    }
  }

  /** 统计某因子的样本数与最新日期，便于 UI 概览 */
  async stats(factorId: string): Promise<{
    rowCount: number;
    symbolCount: number;
    minDate: string | null;
    maxDate: string | null;
  }> {
    await ensureSchema();
    const inst = await getDuckDb();
    const conn = await inst.connect();
    try {
      const sql = `
        SELECT COUNT(*) AS row_count,
               COUNT(DISTINCT symbol) AS symbol_count,
               MIN(date) AS min_date,
               MAX(date) AS max_date
        FROM factor_value WHERE factor_id = '${escapeIdent(factorId)}';
      `;
      const prepared = await conn.prepare(sql);
      const result = await prepared.run();
      const rows = await result.getRows();
      const row = (rows[0] as unknown[]) ?? [0, 0, null, null];
      return {
        rowCount: Number(row[0] ?? 0),
        symbolCount: Number(row[1] ?? 0),
        minDate: this.dateToIso(row[2]) || null,
        maxDate: this.dateToIso(row[3]) || null,
      };
    } finally {
      conn.disconnectSync();
    }
  }

  private toNumberOrNull(v: unknown): number | null {
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private dateToIso(v: unknown): string {
    if (v == null) return "";
    if (typeof v === "string") return v.slice(0, 10);
    // DuckDB DATE 在 node-api 里可能是 { days, ... } 对象
    if (typeof v === "object") {
      const anyV = v as { days?: number };
      if (typeof anyV.days === "number") {
        const d = new Date(anyV.days * 86_400_000);
        return d.toISOString().slice(0, 10);
      }
      try {
        return String(v).slice(0, 10);
      } catch {
        return "";
      }
    }
    return String(v).slice(0, 10);
  }
}

export const factorValueStore = new FactorValueStore();
