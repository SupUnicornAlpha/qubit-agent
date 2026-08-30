import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  strategy,
  strategyComposition,
  strategyEvalRun,
  strategyVersion,
} from "../../db/sqlite/schema";
import type { BacktestJobRecord } from "../backtest/backtest-job-service";
import { matchesFinalHoldoutEvidence } from "../backtest/final-holdout-contract";
import { factorService } from "../factor/factor-service";
import {
  buildStrategyComparisonCohort,
  readStrategyComparisonCohortId,
} from "./strategy-comparison-cohort";

export interface StrategyGateCheck {
  key:
    | "sample_size"
    | "net_sharpe"
    | "sortino"
    | "calmar"
    | "max_drawdown"
    | "cvar95"
    | "positive_period_rate"
    | "turnover"
    | "annual_return"
    | "research_integrity"
    | "pit_integrity"
    | "statistical_confidence";
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
  evalKind: "backtest" | "paper" | "live" | "walk_forward" | "holdout" | "recommendation";
  qualityScore: number | null;
  pass: boolean | null;
  metrics: Record<string, unknown>;
  checks: StrategyGateCheck[];
  createdAt: string;
}

/**
 * Admission decision for a real-money strategy deployment.
 *
 * This deliberately does not reuse a display-only `pass` boolean alone: an
 * evaluation also has to carry the frozen dataset qualification that produced
 * it.  That makes it impossible for a strong-looking research-only backtest
 * to be silently treated as live-trading evidence.
 */
export interface StrategyExecutionAdmission {
  eligible: boolean;
  code:
    | "strategy_evaluation_missing"
    | "strategy_evaluation_failed"
    | "strategy_dataset_not_validation_qualified"
    | "strategy_backtest_integrity_not_passed"
    | "strategy_promotion_incomplete"
    | "strategy_execution_admitted";
  reason: string;
  evaluationId: string | null;
  backtestRunId: string | null;
  datasetSnapshotId: string | null;
}

/** A historical result is deployment evidence only with all PIT prerequisites. */
export function hasValidationQualifiedDataset(metricsJson: unknown): boolean {
  if (!isRecord(metricsJson) || !isRecord(metricsJson.datasetQualification)) return false;
  const qualification = metricsJson.datasetQualification;
  return (
    qualification.useClass === "strategy_validation" &&
    qualification.universeHistory === "verified" &&
    qualification.corporateActions === "verified" &&
    qualification.pointInTime === "verified"
  );
}

export function hasPassedBacktestIntegrity(metricsJson: unknown): boolean {
  return (
    isRecord(metricsJson) &&
    hasPassedBacktestCoreIntegrity(metricsJson.antiLeakageReport) &&
    hasPassedPointInTimeIntegrity(metricsJson.pitReport) &&
    isRecord(metricsJson.statisticalValidationReport) &&
    metricsJson.statisticalValidationReport.status === "passed"
  );
}

export function hasPassedPointInTimeIntegrity(report: unknown): boolean {
  return isRecord(report) && report.pass === true && report.verdict === "point_in_time_clean";
}

/**
 * A base run has no independent OOS by construction. It may pass the core gate
 * when OOS is its only unresolved item; the separate walk-forward evaluation
 * remains mandatory before deployment.
 */
export function hasPassedBacktestCoreIntegrity(report: unknown): boolean {
  if (!isRecord(report)) return false;
  if (report.status === "passed") return true;
  if (report.status !== "research_only") return false;
  const failed = Array.isArray(report.failedChecks) ? report.failedChecks : [];
  const unknown = Array.isArray(report.unknownChecks) ? report.unknownChecks : [];
  return (
    failed.length === 0 &&
    unknown.every((key) => key === "oos_isolation" || key === "embargo_isolation") &&
    unknown.includes("oos_isolation")
  );
}

const DEFAULT_THRESHOLDS = {
  minSampleSize: 30,
  minSharpe: 0.5,
  minSortino: 0.5,
  minCalmar: 0.35,
  maxDrawdown: 0.25,
  maxCvar95: 0.08,
  minPositivePeriodRate: 0.45,
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

    const riskExposureEvidence = await readFactorRiskExposureEvidence(
      db,
      job.compositionId,
      job.config.dataset.snapshotId
    );

    const thresholds = DEFAULT_THRESHOLDS;
    const metrics = job.result.metrics;
    const checks: StrategyGateCheck[] = [
      check("sample_size", "样本量", job.result.meta.sampleSize, thresholds.minSampleSize, ">="),
      check("net_sharpe", "成本后 Sharpe", metrics.sharpe, thresholds.minSharpe, ">="),
      check("sortino", "成本后 Sortino", metrics.sortino ?? 0, thresholds.minSortino, ">="),
      check("calmar", "Calmar", metrics.calmar ?? 0, thresholds.minCalmar, ">="),
      check("max_drawdown", "最大回撤", metrics.maxDrawdown, thresholds.maxDrawdown, "<="),
      check(
        "cvar95",
        "CVaR 95%",
        metrics.conditionalValueAtRisk95 ?? 1,
        thresholds.maxCvar95,
        "<="
      ),
      check(
        "positive_period_rate",
        "正收益期占比",
        metrics.positivePeriodRate ?? 0,
        thresholds.minPositivePeriodRate,
        ">="
      ),
      check("turnover", "换手率", metrics.turnover, thresholds.maxTurnover, "<="),
      check("annual_return", "年化收益", metrics.annualReturn, thresholds.minAnnualReturn, ">"),
      check(
        "research_integrity",
        "研究完整性",
        hasPassedBacktestCoreIntegrity(job.result.meta.antiLeakageReport) ? 1 : 0,
        1,
        ">="
      ),
      check(
        "pit_integrity",
        "PIT 审计",
        hasPassedPointInTimeIntegrity(job.result.meta.pitReport) ? 1 : 0,
        1,
        ">="
      ),
      check(
        "statistical_confidence",
        "统计置信度",
        job.result.meta.statisticalValidationReport?.status === "passed" ? 1 : 0,
        1,
        ">="
      ),
    ];
    const qualityScore = checks.filter((item) => item.pass).length / checks.length;
    const pass = checks.every((item) => item.pass);
    const payload = {
      ...metrics,
      sampleSize: job.result.meta.sampleSize,
      barCount: job.result.meta.barCount,
      skippedDays: job.result.meta.skippedDays,
      costs: job.config.costs,
      // Keep the exact research-input classification alongside the score.
      // It is later consumed by the deployment gate, not inferred from a
      // mutable market feed or a UI label.
      datasetSnapshotId: job.config.dataset.snapshotId,
      datasetQualification:
        job.result.meta.datasetQualification ?? job.config.dataset.qualification,
      antiLeakageReport: job.result.meta.antiLeakageReport ?? null,
      pitReport: job.result.meta.pitReport ?? null,
      statisticalValidationReport: job.result.meta.statisticalValidationReport ?? null,
      factorRiskExposure: riskExposureEvidence,
      comparisonCohort: buildStrategyComparisonCohort(job.config),
      checks,
      gateVersion: "strategy-gate-v4",
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
    const record = await this.getByBacktestRunId(job.id);
    // P2：回测评估 → strategy_eval Experience（失败不阻断 gate）
    try {
      const { upsertStrategyEvalExperience } = await import("../context/finance-memory-writer");
      await upsertStrategyEvalExperience({
        projectId,
        sourceRunId: job.workflowRunId,
        meta: {
          compositionId: job.compositionId ?? undefined,
          strategyVersionId: job.strategyVersionId,
          backtestRunId: job.id,
          evalKind: "backtest",
          metrics: { ...(job.result?.metrics ?? {}), sampleSize: job.result?.meta.sampleSize },
          qualityScore,
          pass,
          asof: job.config.endDate ?? new Date().toISOString().slice(0, 10),
          memoryTier: "intermediate",
        },
      });
    } catch {
      /* finance memory 写失败不阻断 strategy_eval_run */
    }
    return record;
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

async function readFactorRiskExposureEvidence(
  db: DbClient,
  compositionId: string | null,
  datasetSnapshotId: string
): Promise<Record<string, unknown>> {
  if (!compositionId) return { required: false, status: "not_applicable" };
  const composition = await db
    .select({ factorIdsJson: strategyComposition.factorIdsJson })
    .from(strategyComposition)
    .where(eq(strategyComposition.id, compositionId))
    .limit(1);
  const factorIdsJson = composition[0]?.factorIdsJson;
  const factorIds = Array.isArray(factorIdsJson) ? factorIdsJson.map(String).filter(Boolean) : [];
  if (!factorIds.length) return { required: false, status: "not_applicable" };
  const results = await Promise.all(
    factorIds.map(async (factorId) => {
      try {
        return {
          factorId,
          result: await factorService.regressRiskExposures({ factorId, datasetSnapshotId }),
        };
      } catch (error) {
        return { factorId, error: error instanceof Error ? error.message : String(error) };
      }
    })
  );
  const passed = results.every(
    (entry) =>
      "result" in entry &&
      entry.result.coverageStatus === "passed" &&
      entry.result.reasons.length === 0
  );
  return { required: true, status: passed ? "passed" : "incomplete", results };
}

/**
 * Real-money admission is intentionally stricter than a performance report.
 * `research_only` data can remain useful for hypothesis generation and paper
 * experiments, but cannot be used as evidence for a live strategy version.
 */
export async function assessStrategyExecutionAdmission(
  db: DbClient,
  strategyVersionId: string
): Promise<StrategyExecutionAdmission> {
  const rows = await db
    .select({
      id: strategyEvalRun.id,
      backtestRunId: strategyEvalRun.backtestRunId,
      evalKind: strategyEvalRun.evalKind,
      pass: strategyEvalRun.pass,
      metricsJson: strategyEvalRun.metricsJson,
    })
    .from(strategyEvalRun)
    .where(eq(strategyEvalRun.strategyVersionId, strategyVersionId))
    .orderBy(desc(strategyEvalRun.createdAt))
    .limit(40);
  const latestByKind = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!latestByKind.has(row.evalKind)) latestByKind.set(row.evalKind, row);
  }
  const backtest = latestByKind.get("backtest");
  if (!backtest) {
    return {
      eligible: false,
      code: "strategy_evaluation_missing",
      reason: "live strategy requires a completed, approved backtest evaluation",
      evaluationId: null,
      backtestRunId: null,
      datasetSnapshotId: null,
    };
  }

  const metrics = (backtest.metricsJson as Record<string, unknown>) ?? {};
  const datasetSnapshotId =
    typeof metrics.datasetSnapshotId === "string" ? metrics.datasetSnapshotId : null;
  if (!hasValidationQualifiedDataset(metrics)) {
    return {
      eligible: false,
      code: "strategy_dataset_not_validation_qualified",
      reason:
        "live strategy requires a validation-qualified historical dataset (versioned universe, corporate actions, and PIT evidence); research_only backtests are not deployable",
      evaluationId: backtest.id,
      backtestRunId: backtest.backtestRunId,
      datasetSnapshotId,
    };
  }
  if (!hasPassedBacktestIntegrity(metrics)) {
    return {
      eligible: false,
      code: "strategy_backtest_integrity_not_passed",
      reason:
        "live strategy requires base anti-leakage core checks and statisticalValidationReport.status=passed; OOS integrity is enforced by the separate walk-forward gate",
      evaluationId: backtest.id,
      backtestRunId: backtest.backtestRunId,
      datasetSnapshotId,
    };
  }
  if (backtest.pass !== true) {
    return {
      eligible: false,
      code: "strategy_evaluation_failed",
      reason: "latest backtest evaluation did not pass the strategy quality gate",
      evaluationId: backtest.id,
      backtestRunId: backtest.backtestRunId,
      datasetSnapshotId,
    };
  }
  const comparisonCohortId = readStrategyComparisonCohortId(metrics);
  const passedOnBacktestCohort = (kind: "walk_forward" | "paper" | "live") =>
    Boolean(
      comparisonCohortId &&
        rows.some(
          (row) =>
            row.evalKind === kind &&
            row.pass === true &&
            readStrategyComparisonCohortId(row.metricsJson) === comparisonCohortId
        )
    );
  const finalHoldoutPassed = Boolean(
    backtest.backtestRunId &&
      rows.some(
        (row) =>
          row.evalKind === "holdout" &&
          row.pass === true &&
          row.backtestRunId === backtest.backtestRunId &&
          matchesFinalHoldoutEvidence(row.metricsJson, {
            strategyVersionId,
            datasetSnapshotId,
          })
      )
  );
  const missingOrFailed = [
    ...(passedOnBacktestCohort("walk_forward") ? [] : ["walk_forward"]),
    ...(finalHoldoutPassed ? [] : ["holdout"]),
    ...(passedOnBacktestCohort("paper") ? [] : ["paper"]),
    ...(passedOnBacktestCohort("live") ? [] : ["live"]),
  ];
  if (missingOrFailed.length > 0) {
    return {
      eligible: false,
      code: "strategy_promotion_incomplete",
      reason: `live strategy additionally requires a common frozen comparison cohort and passed walk-forward, one reserved final holdout, paper, and explicit human live approval; missing_or_failed=${missingOrFailed.join(",")}`,
      evaluationId: backtest.id,
      backtestRunId: backtest.backtestRunId,
      datasetSnapshotId,
    };
  }
  return {
    eligible: true,
    code: "strategy_execution_admitted",
    reason: "approved_backtest_with_validation_qualified_dataset",
    evaluationId: backtest.id,
    backtestRunId: backtest.backtestRunId,
    datasetSnapshotId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
