import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  strategyEvalRun,
  strategyPnlSnapshot,
  strategyRuntime,
  workflowRun,
} from "../../db/sqlite/schema";
import { ensureStrategyVersionForScript } from "../strategy/strategy-version-resolver";

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
}

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
    const snapshots = await db
      .select()
      .from(strategyPnlSnapshot)
      .where(eq(strategyPnlSnapshot.strategyRuntimeId, strategyRuntimeId));
    const params = (runtime.paramsJson as Record<string, unknown>) ?? {};
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
      tradingDays: days.length,
      netPnl,
      netReturn,
      sharpe,
      maxDrawdown,
      turnover,
      pass,
    });
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
    };
  }

  private async persist(
    db: DbClient,
    input: Omit<PaperEvaluation, "id"> & { projectId: string; workflowRunId: string }
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

function paperScore(input: Omit<PaperEvaluation, "id">): number {
  const checks = [
    input.tradingDays >= 20,
    input.netReturn > 0,
    input.sharpe >= 0.3,
    input.maxDrawdown <= 0.2,
  ];
  return checks.filter(Boolean).length / checks.length;
}

export const paperEvaluationService = new PaperEvaluationService();
