/**
 * DiscoveryService — Agent / 用户驱动的因子挖掘
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §6.4
 *
 * 支持的 job kind：
 *   - factor_alpha101：从内置 Alpha 模板池里筛 IC 最高的若干个
 *   - factor_gp      ：用 GP 生成器随机搜索表达式空间，IC 排名 top-K
 *
 * 评估方式（M4 简化版）：
 *   1. 合成 OHLCV：默认拉真实数据；不可达时用 Brownian motion 合成
 *   2. 用 qlib_expr Provider 算因子值
 *   3. 用 BuiltinFactorEvalProvider 评估 IC / RankIC
 *   4. 按 |IC| 排序，取 top-K
 *
 * 后续可扩展 factor_llm（让 LLM 写表达式）/ genome_evolve（接 gene-pool 真正进化）。
 */

import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  discoveryJob as discoveryJobTable,
} from "../../db/sqlite/schema";
import { parse } from "../provider/impls/factor/qlib-expr/parser";
import { evalQlibExpr as evalExpr, type PriceSeries } from "../provider";
import { generateGbmTicks } from "../../util/synthesize-gbm";
import { providerResolver } from "../provider/resolver";
import { queryBarsRange } from "../market/klines-query";
import type { BarData } from "../../connectors/data/data.connector";
import type {
  FactorComputeRow,
  FactorEvaluationProvider,
} from "../provider/types";
import { ALPHA_TEMPLATES } from "./alpha-templates";
import { GpGenerator } from "./gp-generator";
import { factorService, type FactorRecord } from "../factor/factor-service";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export type DiscoveryKind =
  | "factor_alpha101"
  | "factor_gp"
  | "factor_llm"
  | "rule_llm"
  | "genome_evolve";

export type DiscoveryStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stopped_early";

export interface DiscoverySubmitInput {
  projectId: string;
  kind: DiscoveryKind;
  /** 候选评估用的标的池 */
  symbols: string[];
  startDate: string;
  endDate: string;
  /** 主 horizon；alpha 模板默认 5 */
  horizonDays?: number;
  /** 取 top K（按 |IC|） */
  topK?: number;
  /** kind=factor_gp 时：候选数量 */
  candidateCount?: number;
  /** kind=factor_gp 时：seed */
  seed?: number;
  /**
   * kind=factor_llm 时：由 LLM 一次性产出的 qlib_expr 表达式列表
   * 详见 AGENT_STABILITY_REVIEW.md §四-P0-4
   */
  expressions?: string[];
  /** workflow 关联 */
  workflowRunId?: string;
}

export interface DiscoveryCandidate {
  /** 表达式 ID（模板自带 / GP 随机生成） */
  id: string;
  expr: string;
  lang: "qlib_expr";
  description?: string;
  category?: string;
  metrics: {
    ic: number;
    rankIc: number;
    sampleSize: number;
    /** |IC| 越大越靠前 */
    score: number;
  };
  error?: string;
}

export interface DiscoveryJobRecord {
  id: string;
  projectId: string;
  workflowRunId: string | null;
  kind: DiscoveryKind;
  status: DiscoveryStatus;
  input: DiscoverySubmitInput;
  candidates: DiscoveryCandidate[];
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export class DiscoveryError extends Error {
  constructor(
    public code: "not_found" | "validation_failed" | "execute_failed",
    message: string
  ) {
    super(message);
    this.name = "DiscoveryError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

export class DiscoveryService {
  /** 创建任务（pending） */
  async submit(input: DiscoverySubmitInput): Promise<DiscoveryJobRecord> {
    if (!input.symbols || input.symbols.length === 0) {
      throw new DiscoveryError("validation_failed", "symbols_required");
    }
    const supported: DiscoveryKind[] = ["factor_alpha101", "factor_gp", "factor_llm"];
    if (!supported.includes(input.kind)) {
      throw new DiscoveryError(
        "validation_failed",
        `unsupported_kind_${input.kind}; 当前支持: ${supported.join(" / ")}`
      );
    }
    if (input.kind === "factor_llm") {
      const exprs = (input.expressions ?? []).map((e) => String(e ?? "").trim()).filter(Boolean);
      if (exprs.length === 0) {
        throw new DiscoveryError(
          "validation_failed",
          "expressions_required: factor_llm 至少需要 1 个 qlib_expr 表达式"
        );
      }
    }
    const id = randomUUID();
    const db = await getDb();
    await db.insert(discoveryJobTable).values({
      id,
      projectId: input.projectId,
      workflowRunId: input.workflowRunId ?? null,
      kind: input.kind,
      inputJson: input as never,
      outputJson: { candidates: [] } as never,
      status: "pending",
    });
    return this.get(id);
  }

  /** 同步执行 jobId 的挖掘 */
  async run(jobId: string): Promise<DiscoveryJobRecord> {
    const db = await getDb();
    const job = await this.get(jobId);
    await db
      .update(discoveryJobTable)
      .set({ status: "running" })
      .where(eq(discoveryJobTable.id, jobId));

    try {
      let candidates: DiscoveryCandidate[];
      if (job.kind === "factor_alpha101") {
        candidates = await this.runAlpha101(job.input);
      } else if (job.kind === "factor_gp") {
        candidates = await this.runGp(job.input);
      } else if (job.kind === "factor_llm") {
        candidates = await this.runLlm(job.input);
      } else {
        throw new DiscoveryError("validation_failed", `unsupported_kind_${job.kind}`);
      }

      // |IC| 排序，取 top K
      const sorted = candidates
        .filter((c) => !c.error)
        .sort((a, b) => b.metrics.score - a.metrics.score)
        .slice(0, job.input.topK ?? 10);

      await db
        .update(discoveryJobTable)
        .set({
          status: "succeeded",
          outputJson: { candidates: sorted, totalEvaluated: candidates.length } as never,
          endedAt: new Date().toISOString(),
        })
        .where(eq(discoveryJobTable.id, jobId));
    } catch (e) {
      await db
        .update(discoveryJobTable)
        .set({
          status: "failed",
          error: (e as Error).message,
          endedAt: new Date().toISOString(),
        })
        .where(eq(discoveryJobTable.id, jobId));
      throw new DiscoveryError(
        "execute_failed",
        `discovery_failed: ${(e as Error).message}`
      );
    }
    return this.get(jobId);
  }

  /** submit + run 一步到位 */
  async submitAndRun(input: DiscoverySubmitInput): Promise<DiscoveryJobRecord> {
    const job = await this.submit(input);
    return this.run(job.id);
  }

  async get(jobId: string): Promise<DiscoveryJobRecord> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(discoveryJobTable)
      .where(eq(discoveryJobTable.id, jobId))
      .limit(1);
    const r = rows[0];
    if (!r) throw new DiscoveryError("not_found", `discovery_job_not_found: ${jobId}`);
    return this.rowToRecord(r);
  }

  /**
   * 把候选表达式 promote 成 project 下的正式 FactorRecord
   *
   * 默认 category 走候选自带（GP 候选无 → 用 "momentum"），status=draft（用户可后续 active）。
   */
  async promoteCandidate(
    jobId: string,
    candidateId: string,
    body: {
      name: string;
      category?: FactorRecord["category"];
      status?: FactorRecord["status"];
    }
  ): Promise<FactorRecord> {
    const job = await this.get(jobId);
    const cand = job.candidates.find((c) => c.id === candidateId);
    if (!cand) {
      throw new DiscoveryError(
        "validation_failed",
        `candidate_not_found: ${candidateId} in job ${jobId}`
      );
    }
    if (cand.error) {
      throw new DiscoveryError(
        "validation_failed",
        `candidate_has_error_cannot_promote: ${cand.error}`
      );
    }
    if (!body.name?.trim()) {
      throw new DiscoveryError("validation_failed", "name_required");
    }
    const category =
      body.category ??
      (cand.category as FactorRecord["category"] | undefined) ??
      "momentum";

    return factorService.register({
      projectId: job.projectId,
      name: body.name,
      category,
      expr: cand.expr,
      lang: "qlib_expr",
      horizon: job.input.horizonDays ?? 5,
      status: body.status ?? "draft",
      providerKey: "qlib_expr",
      /**
       * 把发起 discovery 时记下的 workflow_run.id 透传给 factor，使前端「研究产出」
       * 侧栏能严格按工作流过滤。NULL → discovery 是脚本 / API 触发的，没有 workflow。
       */
      ...(job.workflowRunId ? { workflowRunId: job.workflowRunId } : {}),
      definition: {
        promotedFrom: {
          discoveryJobId: jobId,
          candidateId,
          kind: job.kind,
          ic: cand.metrics.ic,
          rankIc: cand.metrics.rankIc,
          score: cand.metrics.score,
          sampleSize: cand.metrics.sampleSize,
        },
      },
    });
  }

  async list(filter: { projectId?: string; kind?: DiscoveryKind } = {}) {
    const db = await getDb();
    const conds = [];
    if (filter.projectId) conds.push(eq(discoveryJobTable.projectId, filter.projectId));
    if (filter.kind) conds.push(eq(discoveryJobTable.kind, filter.kind));
    const q =
      conds.length === 0
        ? db.select().from(discoveryJobTable)
        : db
            .select()
            .from(discoveryJobTable)
            .where(conds.length === 1 ? conds[0] : (await import("drizzle-orm")).and(...conds));
    const rows = await q.orderBy(desc(discoveryJobTable.createdAt));
    return rows.map((r) => this.rowToRecord(r));
  }

  // ── private ──

  private async runAlpha101(input: DiscoverySubmitInput): Promise<DiscoveryCandidate[]> {
    const seriesBySymbol = await this.loadPriceData(input);
    const evaluator = await this.resolveEvaluator();
    const out: DiscoveryCandidate[] = [];
    for (const tpl of ALPHA_TEMPLATES) {
      const cand = await this.evaluateOne(
        { id: tpl.id, expr: tpl.expr, description: tpl.description, category: tpl.category },
        seriesBySymbol,
        input.horizonDays ?? tpl.horizon,
        evaluator
      );
      out.push(cand);
    }
    return out;
  }

  /**
   * P0-4: LLM 一次性产出 N 个表达式 → 内置评估闸门
   *
   * 与 alpha101 / gp 共享 loadPriceData + evaluateOne，所以同样有：
   *   - dry-run（在 evaluateOne 里：parse 失败 / 全 NaN / sampleSize<10 → 候选自带 error）
   *   - IC 评估（合成或真实数据，按 |IC| 排序，run() 里 topK 截断）
   *
   * 调用方（builtin tool `factor.mine.llm`）负责把 LLM 的输出 split 成 expressions[]。
   */
  private async runLlm(input: DiscoverySubmitInput): Promise<DiscoveryCandidate[]> {
    const seriesBySymbol = await this.loadPriceData(input);
    const evaluator = await this.resolveEvaluator();
    const exprs = (input.expressions ?? [])
      .map((e) => String(e ?? "").trim())
      .filter(Boolean);
    const out: DiscoveryCandidate[] = [];
    let idx = 0;
    for (const expr of exprs) {
      out.push(
        await this.evaluateOne(
          { id: `llm_${idx++}`, expr, description: "LLM candidate" },
          seriesBySymbol,
          input.horizonDays ?? 5,
          evaluator
        )
      );
    }
    return out;
  }

  private async runGp(input: DiscoverySubmitInput): Promise<DiscoveryCandidate[]> {
    const seriesBySymbol = await this.loadPriceData(input);
    const evaluator = await this.resolveEvaluator();
    const count = Math.max(5, Math.min(input.candidateCount ?? 30, 200));
    const gp = new GpGenerator({
      maxDepth: 3,
      ...(typeof input.seed === "number" ? { seed: input.seed } : {}),
    });
    const exprs = gp.generateUnique(count);
    const out: DiscoveryCandidate[] = [];
    let idx = 0;
    for (const expr of exprs) {
      out.push(
        await this.evaluateOne(
          { id: `gp_${idx++}`, expr, description: "GP candidate" },
          seriesBySymbol,
          input.horizonDays ?? 5,
          evaluator
        )
      );
    }
    return out;
  }

  /**
   * 拉真实价格；任意 symbol 拿不到 → 用 GBM 合成（保证可单测 + 离线开发）
   */
  private async loadPriceData(input: DiscoverySubmitInput): Promise<
    Map<string, { dates: string[]; series: PriceSeries; closes: number[] }>
  > {
    const out = new Map<string, { dates: string[]; series: PriceSeries; closes: number[] }>();
    for (const sym of input.symbols) {
      let bars: BarData[] = [];
      try {
        bars = await queryBarsRange({
          symbol: sym,
          exchange: "",
          period: "1d",
          startDate: input.startDate,
          endDate: input.endDate,
        });
      } catch {
        bars = [];
      }
      if (!bars || bars.length < 40) {
        bars = synthesizeBars(sym, input.startDate, input.endDate);
      }
      const dates = bars.map((b) => b.timestamp.slice(0, 10));
      const closes = bars.map((b) => b.close);
      const series: PriceSeries = {
        length: bars.length,
        fields: {
          open: bars.map((b) => b.open),
          high: bars.map((b) => b.high),
          low: bars.map((b) => b.low),
          close: closes,
          volume: bars.map((b) => b.volume),
          turnover: bars.map((b) => b.turnover),
          vwap: bars.map((b) => (b.volume > 0 ? b.turnover / b.volume : b.close)),
        },
      };
      out.set(sym, { dates, series, closes });
    }
    return out;
  }

  private async resolveEvaluator(): Promise<FactorEvaluationProvider> {
    return providerResolver.resolve<"factor_eval">("factor_eval", {}, {});
  }

  /** 单个候选：parse → eval per symbol → 算 IC */
  private async evaluateOne(
    cand: { id: string; expr: string; description?: string; category?: string },
    data: Map<string, { dates: string[]; series: PriceSeries; closes: number[] }>,
    horizon: number,
    evaluator: FactorEvaluationProvider
  ): Promise<DiscoveryCandidate> {
    try {
      const ast = parse(cand.expr);
      const values: FactorComputeRow[] = [];
      const futures: FactorComputeRow[] = [];
      for (const [sym, ent] of data) {
        const factorSeries = evalExpr(ast, ent.series);
        for (let i = 0; i + horizon < ent.closes.length; i++) {
          const v = factorSeries[i];
          if (typeof v !== "number" || !Number.isFinite(v)) continue;
          const a = ent.closes[i]!;
          const b = ent.closes[i + horizon]!;
          if (a > 0 && Number.isFinite(b)) {
            values.push({ symbol: sym, date: ent.dates[i]!, value: v });
            futures.push({ symbol: sym, date: ent.dates[i]!, value: b / a - 1 });
          }
        }
      }
      if (values.length < 10) {
        return {
          id: cand.id,
          expr: cand.expr,
          lang: "qlib_expr",
          ...(cand.description ? { description: cand.description } : {}),
          ...(cand.category ? { category: cand.category } : {}),
          metrics: { ic: 0, rankIc: 0, sampleSize: values.length, score: 0 },
          error: "insufficient_samples",
        };
      }
      const r = await evaluator.evaluate({
        factorId: cand.id,
        universe: "discovery",
        values,
        futureReturns: futures,
      });
      return {
        id: cand.id,
        expr: cand.expr,
        lang: "qlib_expr",
        ...(cand.description ? { description: cand.description } : {}),
        ...(cand.category ? { category: cand.category } : {}),
        metrics: {
          ic: r.ic,
          rankIc: r.rankIc,
          sampleSize: r.sampleSize,
          score: Math.abs(r.ic),
        },
        ...(r.error ? { error: r.error } : {}),
      };
    } catch (e) {
      return {
        id: cand.id,
        expr: cand.expr,
        lang: "qlib_expr",
        ...(cand.description ? { description: cand.description } : {}),
        metrics: { ic: 0, rankIc: 0, sampleSize: 0, score: 0 },
        error: (e as Error).message,
      };
    }
  }

  private rowToRecord(r: typeof discoveryJobTable.$inferSelect): DiscoveryJobRecord {
    const output = (r.outputJson as { candidates?: DiscoveryCandidate[] }) ?? { candidates: [] };
    return {
      id: r.id,
      projectId: r.projectId,
      workflowRunId: r.workflowRunId ?? null,
      kind: r.kind,
      status: r.status,
      input: (r.inputJson as unknown) as DiscoverySubmitInput,
      candidates: output.candidates ?? [],
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      error: r.error ?? null,
    };
  }
}

// ─── 合成数据（GBM） ─────────────────────────────────────────────────────────

function synthesizeBars(symbol: string, startDate: string, endDate: string): BarData[] {
  const d0 = new Date(startDate + "T00:00:00Z").getTime();
  const d1 = new Date(endDate + "T00:00:00Z").getTime();
  const dayMs = 86_400_000;
  const n = Math.max(40, Math.floor((d1 - d0) / dayMs) + 1);
  const ticks = generateGbmTicks(symbol, n);
  return ticks.map((t, i) => ({
    symbol,
    exchange: "",
    open: t.open,
    high: t.high,
    low: t.low,
    close: t.close,
    volume: t.volume,
    turnover: t.turnover,
    timestamp: new Date(d0 + i * dayMs).toISOString(),
  }));
}

export const discoveryService = new DiscoveryService();
