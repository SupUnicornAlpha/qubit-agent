/**
 * FactorService — 因子层薄编排服务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.1
 *
 * 职责：
 *   - 因子 CRUD（落 SQLite `factor_definition`）
 *   - 触发计算（走 ProviderResolver → FactorComputeProvider）
 *   - 触发评估（走 ProviderResolver → FactorEvaluationProvider，写 factor_evaluation 留痕）
 *   - 不直接 import qlib/python_inline 等具体实现；统一从 Provider 拿
 *
 * 强制约束：因子值（按 symbol×date×factor 高基数）由 DuckDB/Parquet 承载（P1 落地）。
 * P0 阶段：compute 直接返回 Provider 给的 in-memory rows，不持久化时序数据；evaluate 把汇总指标写入 SQLite。
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  factorDefinition as factorDefTable,
  factorEvaluation as factorEvalTable,
} from "../../db/sqlite/schema";
import { providerResolver } from "../provider/resolver";
import type {
  FactorComputeProvider,
  FactorComputeResult,
  FactorComputeRow,
  FactorEvalResult,
  FactorEvaluationProvider,
  ProviderScope,
} from "../provider/types";
import { factorValueStore } from "./factor-value-store";
import { queryBarsRange } from "../market/klines-query";
import { parse as parseQlibExpr } from "../provider/impls/factor/qlib-expr/parser";
import {
  evalExpr as evalQlibExpr,
  type PriceSeries,
} from "../provider/impls/factor/qlib-expr/evaluator";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export type FactorCategory = "value" | "momentum" | "volatility" | "news" | "quality" | "macro";
export type FactorLang = "qlib_expr" | "python" | "sql" | "jsonlogic";
export type FactorStatus = "draft" | "active" | "archived";

export interface FactorRegisterInput {
  projectId: string;
  name: string;
  category: FactorCategory;
  expr: string;
  lang?: FactorLang;
  universe?: string;
  horizon?: number;
  status?: FactorStatus;
  providerKey?: string;
  /** 任意补充元数据（写入 definition_json） */
  definition?: Record<string, unknown>;
  /**
   * P0-2: 注册前 dry-run 闸门（详见 AGENT_STABILITY_REVIEW.md §四-P0-2）
   *
   * - `false` / 未传：跳过 dry-run（向后兼容；脚本/API/IDE 路径默认行为）
   * - `true` 或对象：注册前在合成 GBM 数据上跑一遍表达式，
   *   - 抛错 / 返回行 < `minRows`（默认 10）/ 全 NaN / 方差 < `minVariance`（默认 1e-12）
   *     → 拒绝注册（抛 validation_failed）
   *   - 通过：注册成功；除非显式传 `status`，否则**强制**为 `draft`，由后续 evaluate 决定是否 active
   *
   * Agent 触发的注册（`builtin-tools.factor.register`）默认开启，避免无效因子污染 `factor_definition` 表。
   *
   * **注意**：dry-run 当前仅对 `lang='qlib_expr'` 真正执行；其他 lang 的 dry-run 会被跳过并写一条 warning 元数据。
   */
  dryRun?: boolean | { minRows?: number; minVariance?: number };
}

export interface FactorRecord {
  id: string;
  projectId: string;
  name: string;
  category: FactorCategory;
  expr: string;
  lang: FactorLang;
  universe: string;
  horizon: number;
  status: FactorStatus;
  providerKey: string;
  definition: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface FactorComputeInput {
  factorId: string;
  startDate: string;
  endDate: string;
  symbols?: string[];
  /** 显式指定 Provider；不传走 ProviderResolver */
  providerKey?: string;
  scope?: ProviderScope;
  /** 是否将结果写入 factor_value（DuckDB）；默认 true */
  persist?: boolean;
}

export interface FactorValueQueryInput {
  factorId: string;
  symbols?: string[];
  startDate?: string;
  endDate?: string;
  latestN?: number;
}

export interface FactorEvaluateInput {
  factorId: string;
  values: FactorComputeRow[];
  futureReturns?: FactorComputeRow[];
  futureReturnsByHorizon?: Record<number, FactorComputeRow[]>;
  groupCount?: number;
  asof?: string;
  /** 显式指定 Provider；不传走 ProviderResolver */
  providerKey?: string;
  scope?: ProviderScope;
}

export interface FactorAutoEvaluateInput {
  factorId: string;
  startDate: string;
  endDate: string;
  symbols?: string[];
  /** 主 horizon；默认从 factor.horizon 取 */
  horizonDays?: number;
  /** 多期 horizon → decay curve；默认 [1,3,5,10,20] */
  decayHorizons?: number[];
  /** 分组数；默认 5 */
  groupCount?: number;
  /** 显式 evaluator Provider */
  providerKey?: string;
  scope?: ProviderScope;
}

export class FactorServiceError extends Error {
  constructor(
    public code: "factor_not_found" | "provider_failed" | "validation_failed" | "duplicate_name",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "FactorServiceError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class FactorService {
  /** 注册因子（落 SQLite + 调 Provider.validateExpr） */
  async register(input: FactorRegisterInput): Promise<FactorRecord> {
    if (!input.name?.trim()) {
      throw new FactorServiceError("validation_failed", "name_required");
    }
    if (!input.expr?.trim()) {
      throw new FactorServiceError("validation_failed", "expr_required");
    }

    const lang: FactorLang = input.lang ?? "python";
    const providerKey = input.providerKey ?? this.defaultProviderKeyForLang(lang);

    // 同 project 内名字不可重复
    const db = await getDb();
    const dup = await db
      .select({ id: factorDefTable.id })
      .from(factorDefTable)
      .where(
        and(eq(factorDefTable.projectId, input.projectId), eq(factorDefTable.name, input.name))
      )
      .limit(1);
    if (dup[0]) {
      throw new FactorServiceError("duplicate_name", `factor_name_already_exists: ${input.name}`);
    }

    // 让 Provider 做 syntax 校验（best effort，不打断 draft 注册）
    let providerHint: { ok: boolean; error?: string } = { ok: true };
    try {
      const provider = await providerResolver.resolve<"factor_compute">(
        "factor_compute",
        {},
        { providerKey }
      );
      providerHint = await provider.validateExpr(input.expr, lang);
    } catch {
      // Provider 不可达不阻塞注册：保留 draft 让 UI 提示
    }

    // P0-2: 强制 dry-run 闸门
    let dryRunMeta: Record<string, unknown> | undefined;
    if (input.dryRun) {
      const opts =
        typeof input.dryRun === "object"
          ? input.dryRun
          : ({} as { minRows?: number; minVariance?: number });
      const dryRunResult = this.runRegistrationDryRun(input.expr, lang, opts);
      if (!dryRunResult.ok) {
        throw new FactorServiceError(
          "validation_failed",
          `dry_run_failed: ${dryRunResult.reason}`,
          { expr: input.expr, lang, ...dryRunResult.detail }
        );
      }
      dryRunMeta = {
        dryRun: {
          ok: true,
          ...dryRunResult.detail,
        },
      };
    }

    const id = randomUUID();
    // 通过 dry-run 后默认进入 draft 池（让上游评估器决定何时 promote 到 active）；
    // 用户显式传 status 时尊重用户输入
    const status: FactorStatus = input.status ?? "draft";
    await db.insert(factorDefTable).values({
      id,
      projectId: input.projectId,
      name: input.name,
      category: input.category,
      definitionJson: {
        ...(input.definition ?? {}),
        ...(providerHint.error ? { providerValidationWarning: providerHint.error } : {}),
        ...(dryRunMeta ?? {}),
      },
      expr: input.expr,
      lang,
      universe: input.universe ?? "CN-A",
      horizon: input.horizon ?? 5,
      status,
      providerKey,
    });

    return this.get(id);
  }

  /**
   * 注册前 dry-run：在合成 GBM 序列上跑一遍表达式，验证可执行性 + 区分度
   *
   * - `qlib_expr` lang：用内置 parser+evaluator 真跑（不依赖任何外部数据源 / Provider）
   * - 其他 lang：当前跳过（在 detail 里写明 reason=lang_unsupported）
   *
   * 检查项（按顺序短路）：
   *   1. 语法解析失败 → `parse_error`
   *   2. 评估抛错 → `eval_error`
   *   3. 有限值行数 < `minRows`（默认 10）→ `insufficient_values`
   *   4. 全常数（方差 < `minVariance`，默认 1e-12）→ `degenerate_constant`
   */
  private runRegistrationDryRun(
    expr: string,
    lang: FactorLang,
    opts: { minRows?: number; minVariance?: number }
  ):
    | { ok: true; detail: Record<string, unknown> }
    | { ok: false; reason: string; detail?: Record<string, unknown> } {
    const minRows = opts.minRows ?? 10;
    const minVariance = opts.minVariance ?? 1e-12;

    if (lang !== "qlib_expr") {
      return {
        ok: true,
        detail: { skipped: true, reason: `lang_unsupported_for_dry_run:${lang}` },
      };
    }

    let ast;
    try {
      ast = parseQlibExpr(expr);
    } catch (e) {
      return { ok: false, reason: `parse_error: ${(e as Error).message}` };
    }

    const symbols = ["__DR_A__", "__DR_B__", "__DR_C__"];
    const finiteCounts: number[] = [];
    const flatValues: number[] = [];

    for (const sym of symbols) {
      const series = synthGbmSeries(sym, 90);
      let factorSeries: Array<number | null>;
      try {
        factorSeries = evalQlibExpr(ast, series);
      } catch (e) {
        return {
          ok: false,
          reason: `eval_error: ${(e as Error).message}`,
          detail: { symbol: sym },
        };
      }
      let n = 0;
      for (const v of factorSeries) {
        if (typeof v === "number" && Number.isFinite(v)) {
          flatValues.push(v);
          n++;
        }
      }
      finiteCounts.push(n);
    }

    if (flatValues.length < minRows) {
      return {
        ok: false,
        reason: "insufficient_values",
        detail: { finiteValues: flatValues.length, minRows, perSymbol: finiteCounts },
      };
    }

    // 方差检查：所有 dry-run symbol 合并后的值方差必须 > minVariance（否则因子完全无区分度）
    let sum = 0;
    for (const v of flatValues) sum += v;
    const mean = sum / flatValues.length;
    let sse = 0;
    for (const v of flatValues) sse += (v - mean) * (v - mean);
    const variance = sse / flatValues.length;
    if (variance < minVariance) {
      return {
        ok: false,
        reason: "degenerate_constant",
        detail: { variance, minVariance, sampleSize: flatValues.length },
      };
    }

    return {
      ok: true,
      detail: {
        sampleSize: flatValues.length,
        variance: Number(variance.toFixed(8)),
        perSymbolFiniteCounts: finiteCounts,
      },
    };
  }

  async get(id: string): Promise<FactorRecord> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(factorDefTable)
      .where(eq(factorDefTable.id, id))
      .limit(1);
    const r = rows[0];
    if (!r) throw new FactorServiceError("factor_not_found", `factor_not_found: ${id}`);
    return this.rowToRecord(r);
  }

  async list(
    filter: { projectId?: string; category?: FactorCategory; status?: FactorStatus } = {}
  ): Promise<FactorRecord[]> {
    const db = await getDb();
    const conds = [];
    if (filter.projectId) conds.push(eq(factorDefTable.projectId, filter.projectId));
    if (filter.category) conds.push(eq(factorDefTable.category, filter.category));
    if (filter.status) conds.push(eq(factorDefTable.status, filter.status));

    const rows = conds.length
      ? await db
          .select()
          .from(factorDefTable)
          .where(and(...conds))
          .orderBy(desc(factorDefTable.createdAt))
      : await db.select().from(factorDefTable).orderBy(desc(factorDefTable.createdAt));
    return rows.map((r) => this.rowToRecord(r));
  }

  async setStatus(id: string, status: FactorStatus): Promise<void> {
    const db = await getDb();
    await db
      .update(factorDefTable)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(factorDefTable.id, id));
  }

  /**
   * 调 Provider 计算因子值；默认写入 DuckDB `factor_value`，下游可 loadValues 取回。
   */
  async compute(input: FactorComputeInput): Promise<FactorComputeResult> {
    const f = await this.get(input.factorId);
    const provider = await this.resolveCompute(f.providerKey, input.providerKey, input.scope);

    let result: FactorComputeResult;
    try {
      result = await provider.compute({
        factorId: f.id,
        expr: f.expr,
        lang: f.lang,
        universe: f.universe,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.symbols ? { symbols: input.symbols } : {}),
      });
    } catch (e) {
      throw new FactorServiceError(
        "provider_failed",
        `factor_compute_failed: ${(e as Error).message}`,
        { factorId: f.id, providerKey: f.providerKey }
      );
    }

    if ((input.persist ?? true) && result.rows.length > 0) {
      try {
        await factorValueStore.upsert({ factorId: f.id, rows: result.rows });
      } catch (e) {
        // 持久化失败不破坏返回结果（计算成功），但记录到 meta.error
        // eslint-disable-next-line no-console
        console.warn(
          `[FactorService] persist factor_value failed for ${f.id}: ${(e as Error).message}`
        );
      }
    }

    return result;
  }

  /** 直接从 DuckDB factor_value 表读取（不重新计算） */
  async loadValues(q: FactorValueQueryInput): Promise<FactorComputeRow[]> {
    const rows = await factorValueStore.query({
      factorId: q.factorId,
      ...(q.symbols ? { symbols: q.symbols } : {}),
      ...(q.startDate ? { startDate: q.startDate } : {}),
      ...(q.endDate ? { endDate: q.endDate } : {}),
      ...(q.latestN ? { latestN: q.latestN } : {}),
    });
    return rows.map((r) => ({ symbol: r.symbol, date: r.date, value: r.value }));
  }

  /** 因子值汇总统计（行数/symbol 数/区间） */
  async valuesStats(factorId: string) {
    return factorValueStore.stats(factorId);
  }

  /** 调 Provider 评估因子；汇总指标写入 factor_evaluation 留痕 */
  async evaluate(input: FactorEvaluateInput): Promise<FactorEvalResult & { evaluationId: string }> {
    const f = await this.get(input.factorId);
    const provider = await this.resolveEval(input.providerKey, input.scope);

    let result: FactorEvalResult;
    try {
      result = await provider.evaluate({
        factorId: f.id,
        universe: f.universe,
        values: input.values,
        ...(input.futureReturns ? { futureReturns: input.futureReturns } : {}),
        ...(input.futureReturnsByHorizon
          ? { futureReturnsByHorizon: input.futureReturnsByHorizon }
          : {}),
        ...(typeof input.groupCount === "number" ? { groupCount: input.groupCount } : {}),
        horizonDays: f.horizon,
      });
    } catch (e) {
      throw new FactorServiceError(
        "provider_failed",
        `factor_evaluate_failed: ${(e as Error).message}`,
        { factorId: f.id }
      );
    }

    const db = await getDb();
    const evaluationId = randomUUID();
    await db.insert(factorEvalTable).values({
      id: evaluationId,
      factorId: f.id,
      asof: input.asof ?? new Date().toISOString().slice(0, 10),
      universe: f.universe,
      providerId: null,
      ic: result.ic,
      rankIc: result.rankIc,
      ir: result.ir,
      turnover: result.turnover,
      decayCurveJson: result.decayCurve as never,
      groupReturnsJson: result.groupReturns as never,
      sampleSize: result.sampleSize,
      latencyMs: result.latencyMs,
      error: result.error ?? null,
    });

    return { ...result, evaluationId };
  }

  /**
   * 自动评估：从 DuckDB 拉因子值 + 从行情拉收盘 → 算 N 期未来收益 → 调 evaluator
   *
   * 与 evaluate 的差异：调用方只提供 factorId + 区间，service 负责拉所有数据。
   * 适合 Agent / CLI 一键评估场景。
   */
  async autoEvaluate(
    input: FactorAutoEvaluateInput
  ): Promise<FactorEvalResult & { evaluationId: string; meta: { horizonDays: number; decayHorizons: number[] } }> {
    const f = await this.get(input.factorId);
    const horizon = input.horizonDays ?? f.horizon ?? 5;
    const decayHorizons =
      input.decayHorizons && input.decayHorizons.length > 0
        ? Array.from(new Set([...input.decayHorizons, horizon])).sort((a, b) => a - b)
        : [1, 3, 5, 10, 20].includes(horizon)
          ? [1, 3, 5, 10, 20]
          : [1, 3, 5, 10, 20, horizon].sort((a, b) => a - b);

    // 1) 拉因子值
    const values = await this.loadValues({
      factorId: f.id,
      ...(input.symbols ? { symbols: input.symbols } : {}),
      startDate: input.startDate,
      endDate: input.endDate,
    });
    if (values.length === 0) {
      throw new FactorServiceError(
        "validation_failed",
        `no_factor_values: factor=${f.id}; 先跑 compute 写入 factor_value 后再评估`
      );
    }

    const symbolSet = new Set<string>();
    for (const v of values) symbolSet.add(v.symbol);
    const symbols = Array.from(symbolSet);

    // 2) 拉行情 → 算多期未来收益
    const closesBySymbol = new Map<string, { dates: string[]; closes: number[] }>();
    const maxHorizon = Math.max(horizon, ...decayHorizons);
    const endExtended = this.shiftDate(input.endDate, maxHorizon + 5);
    for (const sym of symbols) {
      try {
        const bars = await queryBarsRange({
          symbol: sym,
          exchange: "",
          period: "1d",
          startDate: input.startDate,
          endDate: endExtended,
        });
        if (bars.length === 0) continue;
        closesBySymbol.set(sym, {
          dates: bars.map((b) => b.timestamp.slice(0, 10)),
          closes: bars.map((b) => b.close),
        });
      } catch {
        // 单 symbol 缺数据不影响整体
      }
    }

    // 3) 构造 futureReturnsByHorizon
    const byHorizon: Record<number, FactorComputeRow[]> = {};
    for (const h of decayHorizons) {
      byHorizon[h] = this.computeFutureReturns(closesBySymbol, h);
    }
    const mainFutures = byHorizon[horizon] ?? [];

    // 4) 调 evaluate
    const result = await this.evaluate({
      factorId: f.id,
      values,
      futureReturns: mainFutures,
      futureReturnsByHorizon: byHorizon,
      ...(typeof input.groupCount === "number" ? { groupCount: input.groupCount } : {}),
      ...(input.providerKey ? { providerKey: input.providerKey } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
    });
    return { ...result, meta: { horizonDays: horizon, decayHorizons } };
  }

  /** 查询某因子的历史评估记录 */
  async listEvaluations(factorId: string, limit = 20) {
    const db = await getDb();
    return db
      .select()
      .from(factorEvalTable)
      .where(eq(factorEvalTable.factorId, factorId))
      .orderBy(desc(factorEvalTable.asof))
      .limit(limit);
  }

  // ── private ──

  private defaultProviderKeyForLang(lang: FactorLang): string {
    if (lang === "qlib_expr") return "qlib_expr"; // M3 内置纯 TS 实现
    return "python_inline";
  }

  private async resolveCompute(
    factorProviderKey: string,
    explicitKey: string | undefined,
    scope: ProviderScope | undefined
  ): Promise<FactorComputeProvider> {
    const opts =
      explicitKey ?? factorProviderKey
        ? { providerKey: explicitKey ?? factorProviderKey }
        : undefined;
    return providerResolver.resolve<"factor_compute">(
      "factor_compute",
      scope ?? {},
      opts ?? {}
    );
  }

  private async resolveEval(
    explicitKey: string | undefined,
    scope: ProviderScope | undefined
  ): Promise<FactorEvaluationProvider> {
    return providerResolver.resolve<"factor_eval">(
      "factor_eval",
      scope ?? {},
      explicitKey ? { providerKey: explicitKey } : {}
    );
  }

  /** 把价格序列转为「t 日 → t+h 日 close/close - 1」的 FactorComputeRow */
  private computeFutureReturns(
    closesBySymbol: Map<string, { dates: string[]; closes: number[] }>,
    horizonDays: number
  ): FactorComputeRow[] {
    const out: FactorComputeRow[] = [];
    if (horizonDays < 1) return out;
    for (const [sym, ser] of closesBySymbol) {
      for (let i = 0; i + horizonDays < ser.closes.length; i++) {
        const a = ser.closes[i]!;
        const b = ser.closes[i + horizonDays]!;
        if (a > 0 && Number.isFinite(a) && Number.isFinite(b)) {
          out.push({ symbol: sym, date: ser.dates[i]!, value: b / a - 1 });
        }
      }
    }
    return out;
  }

  /** YYYY-MM-DD + days */
  private shiftDate(dateStr: string, days: number): string {
    const d = new Date(dateStr.slice(0, 10) + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  private rowToRecord(r: typeof factorDefTable.$inferSelect): FactorRecord {
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      category: r.category,
      expr: r.expr,
      lang: r.lang,
      universe: r.universe,
      horizon: r.horizon,
      status: r.status,
      providerKey: r.providerKey,
      definition: (r.definitionJson as Record<string, unknown>) ?? {},
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }
}

export const factorService = new FactorService();

/**
 * 合成 GBM 价格序列（90 天默认），用于 register 时的 dry-run。
 * 与 discovery-service.synthesizeBars 同构（seed 基于 symbol 字符串哈希，确保可重复）。
 * 仅产出 OHLCV 字段，不模拟停牌、涨跌停、复权。
 */
function synthGbmSeries(symbol: string, days: number): PriceSeries {
  const n = Math.max(40, days);
  let seed = 0;
  for (const c of symbol) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let px = 50 + (seed % 80);
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  const turnover: number[] = [];
  const vwap: number[] = [];
  for (let i = 0; i < n; i++) {
    const ret = (rand() - 0.5) * 0.04;
    const o = px;
    px = Math.max(1, px * (1 + ret));
    const c = px;
    const h = Math.max(o, c) * (1 + rand() * 0.01);
    const l = Math.min(o, c) * (1 - rand() * 0.01);
    const v = 1_000_000 * (0.5 + rand());
    open.push(o);
    high.push(h);
    low.push(l);
    close.push(c);
    volume.push(v);
    turnover.push(v * c);
    vwap.push(c);
  }
  return {
    length: n,
    fields: { open, high, low, close, volume, turnover, vwap },
  };
}
