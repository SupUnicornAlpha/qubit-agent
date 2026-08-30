import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { strategy, strategyEvalRun, strategyVersion } from "../../db/sqlite/schema";
import {
  type BacktestIntegrityReport,
  buildBacktestIntegrityReport,
} from "../backtest/anti-leakage-report";
import { backtestJobService } from "../backtest/backtest-job-service";
import { bindBacktestDataset } from "../backtest/dataset-snapshot-binding";
import {
  type FinalHoldoutContract,
  createFinalHoldoutContract,
} from "../backtest/final-holdout-contract";
import {
  type BacktestStatisticalValidationReport,
  buildStatisticalValidationReport,
} from "../backtest/statistical-validation-report";
import { providerResolver } from "../provider/resolver";
import type { BacktestProvider, BacktestRequest, BacktestResult } from "../provider/types";

export type FinalHoldoutRunOptions = {
  trainEnd: string;
  holdoutStart: string;
  holdoutEnd: string;
  purgeDays?: number;
  embargoDays?: number;
};

export type FinalHoldoutEvaluation = {
  id: string;
  backtestRunId: string;
  contract: FinalHoldoutContract;
  metrics: BacktestResult["metrics"];
  sampleSize: number;
  integrityReport: BacktestIntegrityReport;
  statisticalValidationReport: BacktestStatisticalValidationReport;
  performancePass: boolean;
  pass: boolean;
};

/**
 * Runs the one reserved test window after all source-run configuration has
 * been frozen. This service does not perform model selection, parameter search
 * or Walk-Forward folds; those belong to the pre-holdout validation stage.
 */
export class FinalHoldoutEvaluationService {
  async run(
    backtestRunId: string,
    options: FinalHoldoutRunOptions
  ): Promise<FinalHoldoutEvaluation> {
    const source = await backtestJobService.get(backtestRunId);
    if (source.status !== "completed" || !source.result) {
      throw new Error("final_holdout_requires_completed_backtest");
    }
    if (source.config.endDate !== options.trainEnd) {
      throw new Error("final_holdout_train_end_must_match_source_backtest_end");
    }
    const purgeDays = normalizeIsolationDays(options.purgeDays, "purge");
    const embargoDays = normalizeIsolationDays(options.embargoDays, "embargo");
    const contract = createFinalHoldoutContract({
      strategyVersionId: source.strategyVersionId,
      datasetSnapshotId: source.config.dataset.snapshotId,
      trainEnd: options.trainEnd,
      holdoutStart: options.holdoutStart,
      holdoutEnd: options.holdoutEnd,
      purgeDays,
      embargoDays,
    });

    const db = await getDb();
    await assertUnusedHoldoutContract(db, backtestRunId, contract);
    // The source request contains a *narrow*, training-only dataset binding.
    // Reusing it here would hand the provider no holdout bars. Bind the
    // reserved window again from exactly the same immutable snapshot rather
    // than letting the provider fall back to runtime data or silently run an
    // empty range.
    const dataset = await bindBacktestDataset({
      snapshotId: contract.datasetSnapshotId,
      symbols: source.config.symbols,
      ...(source.config.benchmark ? { benchmark: source.config.benchmark } : {}),
      startDate: contract.holdoutStart,
      endDate: contract.holdoutEnd,
      timeframe: source.config.dataset.timeframe,
    });
    if (dataset.snapshotId !== contract.datasetSnapshotId) {
      throw new Error("final_holdout_dataset_snapshot_mismatch");
    }
    const provider = await providerResolver.resolve<"backtest">(
      "backtest",
      {},
      { providerKey: source.engineKey }
    );
    const runner = provider as BacktestProvider;
    if (!runner.run) throw new Error(`provider_${source.engineKey}_lacks_run_method`);
    const request: BacktestRequest = {
      ...source.config,
      dataset,
      startDate: contract.holdoutStart,
      endDate: contract.holdoutEnd,
    };
    const result = await runner.run(request);
    if (result.error) throw new Error(`final_holdout_run_failed:${result.error}`);
    const integrityReport = buildBacktestIntegrityReport(request, {
      runtimeDataIsolated: true,
      nextBarExecution: true,
      oos: {
        mode: "holdout",
        foldCount: 1,
        purgeDays: contract.purgeDays,
        embargoDays: contract.embargoDays,
      },
    });
    const statisticalValidationReport = buildStatisticalValidationReport(
      request,
      result.equityCurve
    );
    const performancePass =
      result.meta.sampleSize >= 30 &&
      result.metrics.totalReturn > 0 &&
      result.metrics.sharpe >= 0.3 &&
      result.metrics.maxDrawdown <= 0.3;
    const pass =
      performancePass &&
      integrityReport.status === "passed" &&
      statisticalValidationReport.status === "passed";
    const id = randomUUID();
    const projectId = await readProjectId(db, source.strategyVersionId);
    await db.insert(strategyEvalRun).values({
      id,
      workflowRunId: source.workflowRunId,
      projectId,
      strategyVersionId: source.strategyVersionId,
      compositionId: source.compositionId,
      backtestRunId: source.id,
      scenarioKey: "final_holdout",
      evalKind: "holdout",
      periodStart: contract.holdoutStart,
      periodEnd: contract.holdoutEnd,
      metricsJson: {
        contract,
        metrics: result.metrics,
        sampleSize: result.meta.sampleSize,
        antiLeakageReport: integrityReport,
        statisticalValidationReport,
        performancePass,
        gateVersion: "final-holdout-gate-v1",
      },
      qualityScore: holdoutScore(result),
      pass,
      notes: pass
        ? "final_holdout_passed"
        : performancePass
          ? `final_holdout_integrity_blocked:${integrityReport.status}/${statisticalValidationReport.status}`
          : "final_holdout_performance_gate_failed",
      createdBy: "system",
    });
    return {
      id,
      backtestRunId: source.id,
      contract,
      metrics: result.metrics,
      sampleSize: result.meta.sampleSize,
      integrityReport,
      statisticalValidationReport,
      performancePass,
      pass,
    };
  }
}

function normalizeIsolationDays(value: number | undefined, label: "purge" | "embargo"): number {
  const normalized = value ?? 5;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 30) {
    throw new Error(`final_holdout_${label}_days_invalid`);
  }
  return normalized;
}

async function assertUnusedHoldoutContract(
  db: Awaited<ReturnType<typeof getDb>>,
  backtestRunId: string,
  contract: FinalHoldoutContract
): Promise<void> {
  const rows = await db
    .select({ metricsJson: strategyEvalRun.metricsJson })
    .from(strategyEvalRun)
    .where(
      and(eq(strategyEvalRun.backtestRunId, backtestRunId), eq(strategyEvalRun.evalKind, "holdout"))
    );
  if (rows.length === 0) return;
  const fingerprints = rows
    .map((row) => readContractFingerprint(row.metricsJson))
    .filter((fingerprint): fingerprint is string => Boolean(fingerprint));
  if (fingerprints.includes(contract.fingerprint)) {
    throw new Error("final_holdout_already_evaluated");
  }
  throw new Error("final_holdout_window_already_reserved");
}

function readContractFingerprint(metricsJson: unknown): string | null {
  if (!metricsJson || typeof metricsJson !== "object" || Array.isArray(metricsJson)) return null;
  const contract = (metricsJson as Record<string, unknown>).contract;
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) return null;
  const fingerprint = (contract as Record<string, unknown>).fingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

async function readProjectId(
  db: Awaited<ReturnType<typeof getDb>>,
  strategyVersionId: string
): Promise<string> {
  const rows = await db
    .select({ projectId: strategy.projectId })
    .from(strategyVersion)
    .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
    .where(eq(strategyVersion.id, strategyVersionId))
    .limit(1);
  const projectId = rows[0]?.projectId;
  if (!projectId) throw new Error("strategy_project_not_found");
  return projectId;
}

function holdoutScore(result: BacktestResult): number {
  const checks = [
    result.meta.sampleSize >= 30,
    result.metrics.totalReturn > 0,
    result.metrics.sharpe >= 0.3,
    result.metrics.maxDrawdown <= 0.3,
  ];
  return checks.filter(Boolean).length / checks.length;
}

export const finalHoldoutEvaluationService = new FinalHoldoutEvaluationService();
