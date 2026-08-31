import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  strategyComposition,
  strategyEvalRun,
  strategyPnlSnapshot,
  strategyRuntime,
  workflowRun,
} from "../../db/sqlite/schema";
import { captureWorkflowComponentEvidence } from "../eval-platform/experiment/component-evidence-capture";
import { ensureStrategyVersionForScript } from "../strategy/strategy-version-resolver";
import { readStrategyComparisonCohortId } from "./strategy-comparison-cohort";

export interface PaperEvaluation {
  id: string;
  strategyRuntimeId: string;
  strategyVersionId: string;
  tradingDays: number;
  netPnl: number;
  netReturn: number;
  sharpe: number;
  maxDrawdown: number;
  turnover: number;
  pass: boolean;
  componentEvidenceRecorded: number;
}

type PaperEvaluationMetrics = Omit<PaperEvaluation, "id" | "componentEvidenceRecorded">;
type PaperScoreInput = Pick<
  PaperEvaluationMetrics,
  "tradingDays" | "netReturn" | "sharpe" | "maxDrawdown"
>;

export class PaperEvaluationService {
  async evaluate(strategyRuntimeId: string, client?: DbClient): Promise<PaperEvaluation> {
    const db = client ?? (await getDb());
    const runtimeRows = await db
      .select()
      .from(strategyRuntime)
      .where(eq(strategyRuntime.id, strategyRuntimeId))
      .limit(1);
    const runtime = runtimeRows[0];
    if (!runtime) throw new Error("strategy_runtime_not_found");
    if (runtime.executionMode !== "paper") throw new Error("paper_runtime_required");
    const scriptRows = await db
      .select()
      .from(indicatorStrategyScript)
      .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
      .limit(1);
    const script = scriptRows[0];
    if (!script) throw new Error("strategy_script_not_found");
    const { strategyVersionId, workflowRunId } = await ensureStrategyVersionForScript(db, script);
    const workflowRows = await db
      .select({ projectId: workflowRun.projectId })
      .from(workflowRun)
      .where(eq(workflowRun.id, workflowRunId))
      .limit(1);
    const projectId = workflowRows[0]?.projectId;
    if (!projectId) throw new Error("workflow_project_not_found");
    const params = (runtime.paramsJson as Record<string, unknown>) ?? {};
    const compositionId = await resolvePaperCompositionId(db, params, strategyVersionId);
    const snapshots = await db
      .select()
      .from(strategyPnlSnapshot)
      .where(eq(strategyPnlSnapshot.strategyRuntimeId, strategyRuntimeId));
    const configuredCohort = params.comparisonCohortId;
    const comparisonCohortId = readStrategyComparisonCohortId({
      comparisonCohort: { id: configuredCohort },
    });
    if (configuredCohort !== undefined && !comparisonCohortId) {
      throw new Error("paper_comparison_cohort_id_invalid");
    }
    if (comparisonCohortId) {
      const evaluations = await db
        .select({
          evalKind: strategyEvalRun.evalKind,
          compositionId: strategyEvalRun.compositionId,
          metricsJson: strategyEvalRun.metricsJson,
        })
        .from(strategyEvalRun)
        .where(eq(strategyEvalRun.strategyVersionId, strategyVersionId));
      const supportedKinds = new Set(
        evaluations
          .filter(
            (row) =>
              (!compositionId || row.compositionId === compositionId) &&
              readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId
          )
          .map((row) => row.evalKind)
      );
      if (!supportedKinds.has("backtest") || !supportedKinds.has("walk_forward")) {
        throw new Error("paper_comparison_cohort_not_verified_for_strategy");
      }
    }
    const capital = finitePositive(params.paperCapital) ?? 10_000;
    const daily = new Map<string, { pnl: number; turnover: number }>();
    for (const snapshot of snapshots) {
      const value = daily.get(snapshot.tradingDay) ?? { pnl: 0, turnover: 0 };
      value.pnl += snapshot.realizedPnlDaily + snapshot.unrealizedPnlDaily - snapshot.feeDaily;
      value.turnover += snapshot.turnoverDaily;
      daily.set(snapshot.tradingDay, value);
    }
    const days = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right));
    const returns = days.map(([, value]) => value.pnl / capital);
    const netPnl = days.reduce((sum, [, value]) => sum + value.pnl, 0);
    const netReturn = netPnl / capital;
    const sharpe = annualizedSharpe(returns);
    const maxDrawdown = drawdownFromReturns(returns);
    const turnover = days.reduce((sum, [, value]) => sum + value.turnover, 0) / capital;
    const pass = days.length >= 20 && netReturn > 0 && sharpe >= 0.3 && maxDrawdown <= 0.2;
    const id = await this.persist(db, {
      projectId,
      workflowRunId,
      strategyRuntimeId,
      strategyVersionId,
      compositionId,
      tradingDays: days.length,
      netPnl,
      netReturn,
      sharpe,
      maxDrawdown,
      turnover,
      pass,
      comparisonCohortId,
    });
    const componentEvidenceRecorded = comparisonCohortId
      ? await capturePaperComponentEvidence({
          db,
          projectId,
          workflowRunId,
          runtimeId: strategyRuntimeId,
          comparisonCohortId,
          tradingDays: days.length,
          netReturn,
          sharpe,
          maxDrawdown,
          turnover,
          pass,
          // Runtime params are user/config supplied and therefore cannot act
          // as a cryptographic version for a Harness component. Harnesses get
          // paper evidence only once their profile build identity is persisted.
          harnessVersion: null,
        })
      : 0;
    return {
      id,
      strategyRuntimeId,
      strategyVersionId,
      tradingDays: days.length,
      netPnl,
      netReturn,
      sharpe,
      maxDrawdown,
      turnover,
      pass,
      componentEvidenceRecorded,
    };
  }

  private async persist(
    db: DbClient,
    input: PaperEvaluationMetrics & {
      projectId: string;
      workflowRunId: string;
      comparisonCohortId: string | null;
      compositionId: string | null;
    }
  ) {
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(
        and(
          eq(strategyEvalRun.strategyVersionId, input.strategyVersionId),
          eq(strategyEvalRun.evalKind, "paper")
        )
      );
    const existing = rows.find((row) => {
      const metrics = row.metricsJson as Record<string, unknown>;
      return metrics.strategyRuntimeId === input.strategyRuntimeId;
    });
    const id = existing?.id ?? randomUUID();
    const metricsJson = {
      strategyRuntimeId: input.strategyRuntimeId,
      tradingDays: input.tradingDays,
      netPnl: input.netPnl,
      netReturn: input.netReturn,
      sharpe: input.sharpe,
      maxDrawdown: input.maxDrawdown,
      turnover: input.turnover,
      ...(input.comparisonCohortId ? { comparisonCohort: { id: input.comparisonCohortId } } : {}),
      gateVersion: "paper-gate-v1",
    };
    if (existing) {
      await db
        .update(strategyEvalRun)
        .set({ metricsJson, qualityScore: paperScore(input), pass: input.pass })
        .where(eq(strategyEvalRun.id, id));
    } else {
      await db.insert(strategyEvalRun).values({
        id,
        workflowRunId: input.workflowRunId,
        projectId: input.projectId,
        strategyVersionId: input.strategyVersionId,
        compositionId: input.compositionId,
        scenarioKey: "paper",
        evalKind: "paper",
        metricsJson,
        qualityScore: paperScore(input),
        pass: input.pass,
        notes: input.pass ? "paper_passed" : "paper_gate_failed",
        createdBy: "system",
      });
    }
    return id;
  }
}

async function capturePaperComponentEvidence(input: {
  db: DbClient;
  projectId: string;
  workflowRunId: string;
  runtimeId: string;
  comparisonCohortId: string;
  tradingDays: number;
  netReturn: number;
  sharpe: number;
  maxDrawdown: number;
  turnover: number;
  pass: boolean;
  harnessVersion: string | null;
}): Promise<number> {
  try {
    return await captureWorkflowComponentEvidence({
      projectId: input.projectId,
      workflowRunId: input.workflowRunId,
      comparisonCohortId: input.comparisonCohortId,
      harnessVersion: input.harnessVersion,
      evalKind: "paper",
      sampleSize: input.tradingDays,
      metrics: {
        source: "paper_evaluation",
        strategyRuntimeId: input.runtimeId,
        tradingDays: input.tradingDays,
        netReturn: input.netReturn,
        sharpe: input.sharpe,
        maxDrawdown: input.maxDrawdown,
        turnover: input.turnover,
      },
      qualityScore: paperScore({
        tradingDays: input.tradingDays,
        netReturn: input.netReturn,
        sharpe: input.sharpe,
        maxDrawdown: input.maxDrawdown,
      }),
      pass: input.pass,
      createdBy: "paper_evaluation:component_capture",
      client: input.db,
    });
  } catch (error) {
    // The paper evaluation is canonical strategy evidence. Component capture
    // is a non-authoritative projection and must not erase that result.
    console.warn(
      `[paper-evaluation] component evidence capture failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return 0;
  }
}

/**
 * A paper runtime can bind a composition explicitly. For legacy runtimes we
 * infer only when the strategy version has exactly one composition; ambiguous
 * versions remain unbound and therefore cannot validate a reusable recipe.
 */
async function resolvePaperCompositionId(
  db: DbClient,
  params: Record<string, unknown>,
  strategyVersionId: string
): Promise<string | null> {
  const requested = String(params.compositionId ?? params.strategyCompositionId ?? "").trim();
  const rows = await db
    .select({ id: strategyComposition.id })
    .from(strategyComposition)
    .where(eq(strategyComposition.strategyVersionId, strategyVersionId));
  if (requested) {
    if (!rows.some((row) => row.id === requested)) {
      throw new Error("paper_composition_not_bound_to_strategy_version");
    }
    return requested;
  }
  return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function annualizedSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  const volatility = Math.sqrt(variance);
  return volatility > 0 ? (mean / volatility) * Math.sqrt(252) : mean > 0 ? 99 : 0;
}

function drawdownFromReturns(returns: number[]): number {
  let equity = 1;
  let peak = 1;
  let drawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return drawdown;
}

function paperScore(input: PaperScoreInput): number {
  const checks = [
    input.tradingDays >= 20,
    input.netReturn > 0,
    input.sharpe >= 0.3,
    input.maxDrawdown <= 0.2,
  ];
  return checks.filter(Boolean).length / checks.length;
}

export const paperEvaluationService = new PaperEvaluationService();

const DEFAULT_PAPER_EVALUATION_TICK_MS = 6 * 60 * 60 * 1000;

/**
 * Re-evaluates paper runtimes after PnL materialization. It is deliberately
 * separate from the execution worker: a broker fill is not itself a mature
 * paper result, and the service already keeps writes idempotent per runtime.
 */
export class PaperEvaluationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const db = await getDb();
      const runtimes = await db
        .select({ id: strategyRuntime.id })
        .from(strategyRuntime)
        .where(eq(strategyRuntime.executionMode, "paper"));
      for (const runtime of runtimes) {
        try {
          await paperEvaluationService.evaluate(runtime.id, db);
        } catch (error) {
          console.warn(
            `[paper-evaluation] runtime=${runtime.id} failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.timer || process.env.QUBIT_PAPER_EVALUATION_ENABLED === "0") return;
    const configuredMs = Number(process.env.QUBIT_PAPER_EVALUATION_TICK_MS);
    const tickMs =
      Number.isFinite(configuredMs) && configuredMs >= 60_000
        ? configuredMs
        : DEFAULT_PAPER_EVALUATION_TICK_MS;
    this.startupTimer = setTimeout(() => void this.tick(), 90_000);
    this.timer = setInterval(() => void this.tick(), tickMs);
  }

  stop(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }
}

export const paperEvaluationWorker = new PaperEvaluationWorker();
