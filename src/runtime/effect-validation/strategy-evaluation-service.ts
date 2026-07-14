import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { strategy, strategyEvalRun, strategyVersion } from "../../db/sqlite/schema";
import type { BacktestJobRecord } from "../backtest/backtest-job-service";

export interface StrategyGateCheck {
  key: "sample_size" | "net_sharpe" | "max_drawdown" | "turnover" | "annual_return";
  label: string;
  value: number;
  threshold: number;
  operator: ">=" | "<=" | ">";
  pass: boolean;
}

export interface StrategyEvaluationRecord {
  id: string;
  backtestRunId: string;
  strategyVersionId: string | null;
  evalKind: "backtest" | "paper" | "live" | "walk_forward" | "recommendation";
  qualityScore: number | null;
  pass: boolean | null;
  metrics: Record<string, unknown>;
  checks: StrategyGateCheck[];
  createdAt: string;
}

const DEFAULT_THRESHOLDS = {
  minSampleSize: 30,
  minSharpe: 0.5,
  maxDrawdown: 0.25,
  maxTurnover: 12,
  minAnnualReturn: 0,
};

export class StrategyEvaluationService {
  async evaluateCompletedBacktest(
    job: BacktestJobRecord
  ): Promise<StrategyEvaluationRecord | null> {
    if (job.status !== "completed" || !job.result) return null;
    const db = await getDb();
    const projectRows = await db
      .select({ projectId: strategy.projectId })
      .from(strategyVersion)
      .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
      .where(eq(strategyVersion.id, job.strategyVersionId))
      .limit(1);
    const projectId = projectRows[0]?.projectId;
    if (!projectId) return null;

    const thresholds = DEFAULT_THRESHOLDS;
    const metrics = job.result.metrics;
    const checks: StrategyGateCheck[] = [
      check("sample_size", "样本量", job.result.meta.sampleSize, thresholds.minSampleSize, ">="),
      check("net_sharpe", "成本后 Sharpe", metrics.sharpe, thresholds.minSharpe, ">="),
      check("max_drawdown", "最大回撤", metrics.maxDrawdown, thresholds.maxDrawdown, "<="),
      check("turnover", "换手率", metrics.turnover, thresholds.maxTurnover, "<="),
      check("annual_return", "年化收益", metrics.annualReturn, thresholds.minAnnualReturn, ">"),
    ];
    const qualityScore = checks.filter((item) => item.pass).length / checks.length;
    const pass = checks.every((item) => item.pass);
    const payload = {
      ...metrics,
      sampleSize: job.result.meta.sampleSize,
      barCount: job.result.meta.barCount,
      skippedDays: job.result.meta.skippedDays,
      costs: job.config.costs,
      checks,
      gateVersion: "strategy-gate-v1",
    };
    const existing = await db
      .select({ id: strategyEvalRun.id })
      .from(strategyEvalRun)
      .where(
        and(eq(strategyEvalRun.backtestRunId, job.id), eq(strategyEvalRun.evalKind, "backtest"))
      )
      .limit(1);
    const id = existing[0]?.id ?? randomUUID();
    if (existing[0]) {
      await db
        .update(strategyEvalRun)
        .set({ metricsJson: payload, qualityScore, pass, notes: gateNotes(checks) })
        .where(eq(strategyEvalRun.id, id));
    } else {
      await db.insert(strategyEvalRun).values({
        id,
        workflowRunId: job.workflowRunId,
        projectId,
        strategyVersionId: job.strategyVersionId,
        compositionId: job.compositionId,
        backtestRunId: job.id,
        evalKind: "backtest",
        periodStart: job.config.startDate,
        periodEnd: job.config.endDate,
        metricsJson: payload,
        qualityScore,
        pass,
        notes: gateNotes(checks),
        createdBy: "system",
      });
    }
    return this.getByBacktestRunId(job.id);
  }

  async getByBacktestRunId(backtestRunId: string): Promise<StrategyEvaluationRecord | null> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(
        and(
          eq(strategyEvalRun.backtestRunId, backtestRunId),
          eq(strategyEvalRun.evalKind, "backtest")
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const metrics = (row.metricsJson as Record<string, unknown>) ?? {};
    return {
      id: row.id,
      backtestRunId,
      strategyVersionId: row.strategyVersionId,
      evalKind: row.evalKind,
      qualityScore: row.qualityScore,
      pass: row.pass,
      metrics,
      checks: Array.isArray(metrics.checks) ? (metrics.checks as StrategyGateCheck[]) : [],
      createdAt: row.createdAt,
    };
  }
}

function check(
  key: StrategyGateCheck["key"],
  label: string,
  value: number,
  threshold: number,
  operator: StrategyGateCheck["operator"]
): StrategyGateCheck {
  const pass =
    operator === ">="
      ? value >= threshold
      : operator === "<="
        ? value <= threshold
        : value > threshold;
  return { key, label, value, threshold, operator, pass };
}

function gateNotes(checks: StrategyGateCheck[]): string {
  const failed = checks.filter((item) => !item.pass).map((item) => item.label);
  return failed.length === 0 ? "backtest_passed" : `gate_failed: ${failed.join(", ")}`;
}

export const strategyEvaluationService = new StrategyEvaluationService();
