/**
 * BacktestJobService — 把 BacktestProvider 包装成持久化任务
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §8.1
 *
 * 工作流：
 *   1. submit(input) → 写入 backtest_run（status=pending）
 *   2. 异步触发 run(jobId)：拉 composition → 构造 BacktestRequest → 调 BacktestProvider.run
 *   3. 结果落 performanceJson（metrics + equityCurve + trades）
 *
 * 与 backtestJob（runner.ts）的关系：
 *   - backtestJob 是旧的「SMA crossover / Python strategy」专用表
 *   - backtestRun 是统一的事件驱动回测表，引擎可插拔（engineKey / providerId）
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  backtestRun as backtestRunTable,
  strategyVersion as strategyVersionTable,
} from "../../db/sqlite/schema";
import {
  type StrategyEvaluationRecord,
  strategyEvaluationService,
} from "../effect-validation/strategy-evaluation-service";
import { factorService } from "../factor/factor-service";
import { providerResolver } from "../provider/resolver";
import type {
  BacktestCosts,
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
  BacktestSignalSpec,
  ProviderScope,
} from "../provider/types";
import { strategyComposer } from "../strategy/strategy-composer";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface BacktestJobSubmitInput {
  strategyVersionId: string;
  /** 二选一：从 composition 自动展开 signals */
  compositionId?: string;
  signals?: BacktestSignalSpec;
  symbols: string[];
  universe?: string;
  startDate: string;
  endDate: string;
  capital?: number;
  costs?: BacktestCosts;
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  /** 显式 BacktestProvider key（默认 event_driven） */
  providerKey?: string;
  scope?: ProviderScope;
  /** 产物 lineage（migration 0080） */
  workflowRunId?: string | null;
  createdBy?: "user" | "agent" | "system" | string;
  agentInstanceId?: string | null;
}

export interface BacktestJobRecord {
  id: string;
  strategyVersionId: string;
  status: "pending" | "running" | "completed" | "failed";
  engineKey: string;
  providerId: string | null;
  config: BacktestRequest;
  result: BacktestResult | null;
  startedAt: string;
  endedAt: string | null;
  /** 产物 lineage（migration 0080） */
  createdBy: string;
  workflowRunId: string | null;
  agentInstanceId: string | null;
  compositionId: string | null;
  evaluation: StrategyEvaluationRecord | null;
}

export class BacktestJobError extends Error {
  constructor(
    public code:
      | "validation_failed"
      | "composition_not_found"
      | "strategy_version_not_found"
      | "provider_failed"
      | "job_not_found",
    message: string
  ) {
    super(message);
    this.name = "BacktestJobError";
  }
}

// ─── Service ────────────────────────────────────────────────────────────────

const DEFAULT_COSTS: BacktestCosts = {
  commissionBps: 5,
  slippageBps: 5,
};

export class BacktestJobService {
  /** 创建任务（pending），不立即执行 */
  async submit(input: BacktestJobSubmitInput): Promise<BacktestJobRecord> {
    const db = await getDb();

    // 1) 校验 strategy_version 存在
    const sv = await db
      .select()
      .from(strategyVersionTable)
      .where(eq(strategyVersionTable.id, input.strategyVersionId))
      .limit(1);
    if (!sv[0]) {
      throw new BacktestJobError(
        "strategy_version_not_found",
        `strategy_version_not_found: ${input.strategyVersionId}`
      );
    }

    // 2) 解析 signals
    const signals = await this.resolveSignals(input);

    // 3) 构造 BacktestRequest
    const request: BacktestRequest = {
      strategyVersionId: input.strategyVersionId,
      signals,
      universe: input.universe ?? "CN-A",
      symbols: input.symbols,
      startDate: input.startDate,
      endDate: input.endDate,
      capital: input.capital ?? 1_000_000,
      costs: input.costs ?? DEFAULT_COSTS,
      ...(input.rebalance ? { rebalance: input.rebalance } : {}),
      ...(typeof input.topN === "number" && input.topN > 0 ? { topN: input.topN } : {}),
      ...(typeof input.longShort === "boolean" ? { longShort: input.longShort } : {}),
      ...(input.benchmark ? { benchmark: input.benchmark } : {}),
    };

    const providerKey = input.providerKey ?? "event_driven";
    const id = randomUUID();
    await db.insert(backtestRunTable).values({
      id,
      strategyVersionId: input.strategyVersionId,
      agentInstanceId: input.agentInstanceId ?? null,
      connectorInstanceId: "",
      datasetSnapshotId: "",
      configJson: request as never,
      performanceJson: null,
      status: "pending",
      providerId: null,
      engineKey: providerKey,
      createdBy: input.createdBy ?? "user",
      workflowRunId: input.workflowRunId ?? null,
      compositionId: input.compositionId ?? null,
    });

    return this.get(id);
  }

  /**
   * 同步执行 jobId 的回测。一般由 submit() 之后异步 fire-and-forget 调用。
   * 这里保留 await 形式，便于测试与小数据规模直接同步使用。
   */
  async run(jobId: string): Promise<BacktestJobRecord> {
    const job = await this.get(jobId);
    if (job.status !== "pending") {
      // 重跑不阻塞：把状态置回 running
    }
    const db = await getDb();
    await db
      .update(backtestRunTable)
      .set({ status: "running" })
      .where(eq(backtestRunTable.id, jobId));

    try {
      const provider = await providerResolver.resolve<"backtest">(
        "backtest",
        {},
        {
          providerKey: job.engineKey,
        }
      );
      const bp = provider as BacktestProvider;
      if (typeof bp.run !== "function") {
        throw new BacktestJobError("provider_failed", `provider_${job.engineKey}_lacks_run_method`);
      }
      const result = await bp.run(job.config);

      await db
        .update(backtestRunTable)
        .set({
          status: result.error ? "failed" : "completed",
          performanceJson: result as never,
          providerId: provider.meta.key,
          endedAt: new Date().toISOString(),
        })
        .where(eq(backtestRunTable.id, jobId));
    } catch (e) {
      await db
        .update(backtestRunTable)
        .set({
          status: "failed",
          performanceJson: { error: (e as Error).message } as never,
          endedAt: new Date().toISOString(),
        })
        .where(eq(backtestRunTable.id, jobId));
      throw new BacktestJobError("provider_failed", `backtest_run_failed: ${(e as Error).message}`);
    }
    const completed = await this.get(jobId);
    await strategyEvaluationService.evaluateCompletedBacktest(completed);
    return this.get(jobId);
  }

  /** submit + run 一步到位 */
  async submitAndRun(input: BacktestJobSubmitInput): Promise<BacktestJobRecord> {
    const job = await this.submit(input);
    return this.run(job.id);
  }

  async get(jobId: string): Promise<BacktestJobRecord> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(backtestRunTable)
      .where(eq(backtestRunTable.id, jobId))
      .limit(1);
    const r = rows[0];
    if (!r) throw new BacktestJobError("job_not_found", `backtest_job_not_found: ${jobId}`);
    const record = this.rowToRecord(r);
    record.evaluation = await strategyEvaluationService.getByBacktestRunId(jobId);
    return record;
  }

  async list(filter: { strategyVersionId?: string; status?: BacktestJobRecord["status"] } = {}) {
    const db = await getDb();
    const conds = [];
    if (filter.strategyVersionId)
      conds.push(eq(backtestRunTable.strategyVersionId, filter.strategyVersionId));
    if (filter.status) conds.push(eq(backtestRunTable.status, filter.status));
    const rows = conds.length
      ? await db
          .select()
          .from(backtestRunTable)
          .where(and(...conds))
          .orderBy(desc(backtestRunTable.startedAt))
      : await db.select().from(backtestRunTable).orderBy(desc(backtestRunTable.startedAt));
    return Promise.all(
      rows.map(async (r) => ({
        ...this.rowToRecord(r),
        evaluation: await strategyEvaluationService.getByBacktestRunId(r.id),
      }))
    );
  }

  // ── private ──

  /**
   * 根据 input 解析最终 BacktestSignalSpec：
   *   - 优先用 input.signals（已显式给）
   *   - 否则从 compositionId 解析：取第一个 factor 的 expr/lang 作为 factor_score
   *     （strategy_composition 支持多因子聚合，但事件驱动回测目前要单一因子分数；
   *      后续扩展可在 EventDrivenBacktestProvider 里加多因子加权打分）
   */
  private async resolveSignals(input: BacktestJobSubmitInput): Promise<BacktestSignalSpec> {
    if (input.signals) return input.signals;
    if (!input.compositionId) {
      throw new BacktestJobError("validation_failed", "either_signals_or_composition_id_required");
    }
    const comp = await strategyComposer.get(input.compositionId);
    if (comp.factorIds.length === 0) {
      throw new BacktestJobError(
        "validation_failed",
        `composition_${comp.id}_has_no_factor_for_backtest`
      );
    }
    const factorId = comp.factorIds[0];
    if (!factorId) {
      throw new BacktestJobError(
        "validation_failed",
        `composition_${comp.id}_has_no_factor_for_backtest`
      );
    }
    const factor = await factorService.get(factorId);
    return {
      kind: "factor_score",
      factorId: factor.id,
      expr: factor.expr,
      lang: factor.lang,
    };
  }

  private rowToRecord(r: typeof backtestRunTable.$inferSelect): BacktestJobRecord {
    return {
      id: r.id,
      strategyVersionId: r.strategyVersionId,
      status: r.status,
      engineKey: r.engineKey,
      providerId: r.providerId ?? null,
      config: r.configJson as unknown as BacktestRequest,
      result: (r.performanceJson as unknown as BacktestResult | null) ?? null,
      startedAt: r.startedAt,
      endedAt: r.endedAt ?? null,
      createdBy: r.createdBy ?? "user",
      workflowRunId: r.workflowRunId ?? null,
      agentInstanceId: r.agentInstanceId ?? null,
      compositionId: r.compositionId ?? null,
      evaluation: null,
    };
  }
}

export const backtestJobService = new BacktestJobService();
