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
  strategy as strategyTable,
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
  BacktestInstrumentSpec,
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
  BacktestSignalSpec,
  ProviderScope,
} from "../provider/types";
import { strategyComposer } from "../strategy/strategy-composer";
import { compactBacktestResult } from "../util/compact-heavy-json";
import { DatasetSnapshotBindingError, bindBacktestDataset } from "./dataset-snapshot-binding";

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface BacktestJobSubmitInput {
  strategyVersionId: string;
  /** 必须引用在运行前冻结的 market snapshot；不允许回测时临时取数。 */
  datasetSnapshotId?: string;
  /** 二选一：从 composition 自动展开 signals */
  compositionId?: string;
  signals?: BacktestSignalSpec;
  symbols: string[];
  /** Must exactly match the immutable market snapshot's bar frequency. */
  timeframe?: string;
  /** 冻结的合约元数据；期权/期货/永续回测必须显式提供。 */
  instruments?: Record<string, BacktestInstrumentSpec>;
  universe?: string;
  startDate: string;
  endDate: string;
  capital?: number;
  costs?: BacktestCosts;
  rebalance?: "daily" | "weekly" | "monthly";
  topN?: number;
  longShort?: boolean;
  benchmark?: string;
  /** Records how parameters were selected before this experiment. */
  experiment?: BacktestRequest["experiment"];
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
      | "dataset_snapshot_required"
      | "dataset_snapshot_not_found"
      | "dataset_snapshot_invalid"
      | "dataset_snapshot_coverage_missing"
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
  costModelVersion: "builtin-default-v1",
  costModelSource: "unverified_default_assumption",
};

const PARAMETER_SELECTION_VALUES = new Set([
  "fixed_before_run",
  "full_sample_optimized",
  "unknown",
]);

function normalizeExperiment(
  experiment: BacktestJobSubmitInput["experiment"]
): NonNullable<BacktestRequest["experiment"]> {
  if (!experiment) return { parameterSelection: "unknown" };
  if (!PARAMETER_SELECTION_VALUES.has(experiment.parameterSelection)) {
    throw new BacktestJobError(
      "validation_failed",
      `invalid_parameter_selection: ${String(experiment.parameterSelection)}`
    );
  }
  const preRegistrationId = experiment.preRegistrationId?.trim();
  const candidateTrials = experiment.candidateTrials;
  if (
    candidateTrials !== undefined &&
    (!Number.isInteger(candidateTrials) || candidateTrials < 1 || candidateTrials > 10_000)
  ) {
    throw new BacktestJobError(
      "validation_failed",
      `invalid_candidate_trials: ${String(candidateTrials)}`
    );
  }
  return {
    parameterSelection: experiment.parameterSelection,
    ...(preRegistrationId ? { preRegistrationId } : {}),
    ...(candidateTrials !== undefined ? { candidateTrials } : {}),
  };
}

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

    // 3) 在提交时绑定不可变快照。Provider 只能消费此数据，不能运行时重新取行情。
    const timeframe = input.timeframe?.trim() || "1d";
    let dataset: BacktestRequest["dataset"];
    try {
      dataset = await bindBacktestDataset({
        ...(input.datasetSnapshotId ? { snapshotId: input.datasetSnapshotId } : {}),
        symbols: input.symbols,
        ...(input.benchmark ? { benchmark: input.benchmark } : {}),
        startDate: input.startDate,
        endDate: input.endDate,
        timeframe,
      });
    } catch (error) {
      if (error instanceof DatasetSnapshotBindingError) {
        throw new BacktestJobError(error.code, error.message);
      }
      throw error;
    }

    // 4) 构造 BacktestRequest
    const request: BacktestRequest = {
      strategyVersionId: input.strategyVersionId,
      dataset,
      signals,
      universe: input.universe ?? "CN-A",
      symbols: input.symbols,
      ...(input.instruments ? { instruments: input.instruments } : {}),
      startDate: input.startDate,
      endDate: input.endDate,
      capital: input.capital ?? 1_000_000,
      costs: input.costs ?? DEFAULT_COSTS,
      ...(input.rebalance ? { rebalance: input.rebalance } : {}),
      ...(typeof input.topN === "number" && input.topN > 0 ? { topN: input.topN } : {}),
      ...(typeof input.longShort === "boolean" ? { longShort: input.longShort } : {}),
      ...(input.benchmark ? { benchmark: input.benchmark } : {}),
      experiment: normalizeExperiment(input.experiment),
    };

    const providerKey = input.providerKey ?? "event_driven";
    const id = randomUUID();
    await db.insert(backtestRunTable).values({
      id,
      strategyVersionId: input.strategyVersionId,
      agentInstanceId: input.agentInstanceId ?? null,
      connectorInstanceId: "",
      datasetSnapshotId: dataset.snapshotId,
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

  async list(
    filter: {
      strategyVersionId?: string;
      status?: BacktestJobRecord["status"];
      projectId?: string;
      workflowRunId?: string;
    } = {}
  ) {
    const db = await getDb();
    const conds = [];
    if (filter.strategyVersionId)
      conds.push(eq(backtestRunTable.strategyVersionId, filter.strategyVersionId));
    if (filter.status) conds.push(eq(backtestRunTable.status, filter.status));
    if (filter.workflowRunId) conds.push(eq(backtestRunTable.workflowRunId, filter.workflowRunId));

    const projectId = filter.projectId?.trim();
    const withProject = Boolean(projectId);
    const rows = withProject
      ? await db
          .select({ run: backtestRunTable })
          .from(backtestRunTable)
          .innerJoin(
            strategyVersionTable,
            eq(strategyVersionTable.id, backtestRunTable.strategyVersionId)
          )
          .innerJoin(strategyTable, eq(strategyTable.id, strategyVersionTable.strategyId))
          .where(
            and(eq(strategyTable.projectId, projectId ?? ""), ...(conds.length > 0 ? conds : []))
          )
          .orderBy(desc(backtestRunTable.startedAt))
          .then((items) => items.map((item) => item.run))
      : conds.length
        ? await db
            .select()
            .from(backtestRunTable)
            .where(and(...conds))
            .orderBy(desc(backtestRunTable.startedAt))
        : await db.select().from(backtestRunTable).orderBy(desc(backtestRunTable.startedAt));
    return Promise.all(
      rows.map(async (r) => {
        const record = this.rowToRecord(r);
        // List payloads must stay light — Team research UI loads these for every workflow.
        // Full equity/trades are available via get(jobId) for BacktestStudio detail/charts.
        if (record.result) {
          record.result = compactBacktestResult(record.result) as BacktestResult;
        }
        return {
          ...record,
          evaluation: await strategyEvaluationService.getByBacktestRunId(r.id),
        };
      })
    );
  }

  // ── private ──

  /**
   * 根据 input 解析最终 BacktestSignalSpec：
   *   - 优先用 input.signals（已显式给）
   *   - 否则从 compositionId 解析：单因子保留 factor_score；多因子转成
   *     factor_composite，由事件引擎在同一快照上做截面排名后加权合成。
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
    const factors = await Promise.all(
      comp.factorIds.map((factorId) => factorService.get(factorId))
    );
    if (factors.some((factor) => factor.lang !== "qlib_expr")) {
      throw new BacktestJobError(
        "validation_failed",
        `composition_${comp.id}_contains_non_snapshot_factor: event_driven requires qlib_expr`
      );
    }
    if (factors.length === 1) {
      const factor = factors[0];
      if (!factor) throw new BacktestJobError("validation_failed", "composition_factor_missing");
      return { kind: "factor_score", factorId: factor.id, expr: factor.expr, lang: "qlib_expr" };
    }
    const weights = await this.resolveCompositionWeights(
      factors.map((factor) => ({ id: factor.id, name: factor.name })),
      comp.weightMethod,
      comp.params,
      input.datasetSnapshotId
    );
    return {
      kind: "factor_composite",
      factors: factors.map((factor) => ({
        factorId: factor.id,
        expr: factor.expr,
        lang: "qlib_expr",
        weight: weights.get(factor.id) ?? 0,
      })),
    };
  }

  private async resolveCompositionWeights(
    factors: Array<{ id: string; name: string }>,
    method: "equal" | "rank_ic_weighted" | "ic_ir_weighted" | "manual",
    params: Record<string, unknown>,
    datasetSnapshotId?: string
  ): Promise<Map<string, number>> {
    const factorIds = factors.map((factor) => factor.id);
    const raw = new Map<string, number>();
    if (method === "manual") {
      const configured =
        params.factorWeights &&
        typeof params.factorWeights === "object" &&
        !Array.isArray(params.factorWeights)
          ? (params.factorWeights as Record<string, unknown>)
          : {};
      for (const factor of factors) {
        raw.set(factor.id, Number(configured[factor.id] ?? configured[factor.name] ?? 0));
      }
    } else if (method === "rank_ic_weighted" || method === "ic_ir_weighted") {
      const metric = method === "rank_ic_weighted" ? "rankIc" : "ir";
      const learned = await factorService.getLatestEvaluationMetric(
        factorIds,
        metric,
        datasetSnapshotId
      );
      if (learned.size === 0) {
        throw new BacktestJobError(
          "validation_failed",
          `${method}_no_factor_evaluation_for_snapshot: run factor.autoEvaluate with dataset_snapshot_id=${datasetSnapshotId ?? "required"} first or use equal weighting`
        );
      }
      for (const factorId of factorIds) raw.set(factorId, Math.abs(learned.get(factorId) ?? 0));
    } else {
      for (const factorId of factorIds) raw.set(factorId, 1);
    }
    const absoluteTotal = Array.from(raw.values()).reduce(
      (sum, value) => sum + (Number.isFinite(value) ? Math.abs(value) : 0),
      0
    );
    const fallback = 1 / factorIds.length;
    return new Map(
      factorIds.map((factorId) => [
        factorId,
        absoluteTotal > 1e-12 && Number.isFinite(raw.get(factorId) ?? 0)
          ? (raw.get(factorId) ?? 0) / absoluteTotal
          : method === "manual"
            ? 0
            : fallback,
      ])
    );
  }

  private rowToRecord(r: typeof backtestRunTable.$inferSelect): BacktestJobRecord {
    let config: BacktestRequest;
    try {
      config = typeof r.configJson === "string" ? JSON.parse(r.configJson) : r.configJson;
    } catch {
      config = r.configJson as unknown as BacktestRequest;
    }

    let result: BacktestResult | null = null;
    if (r.performanceJson) {
      try {
        result =
          typeof r.performanceJson === "string"
            ? JSON.parse(r.performanceJson)
            : (r.performanceJson as unknown as BacktestResult);
      } catch {
        result = r.performanceJson as unknown as BacktestResult;
      }
    }

    return {
      id: r.id,
      strategyVersionId: r.strategyVersionId,
      status: r.status,
      engineKey: r.engineKey,
      providerId: r.providerId ?? null,
      config,
      result,
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
