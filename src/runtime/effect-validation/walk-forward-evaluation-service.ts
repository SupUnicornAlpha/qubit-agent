import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BarData } from "../../connectors/data/data.connector";
import { getDb } from "../../db/sqlite/client";
import { strategy, strategyEvalRun, strategyVersion } from "../../db/sqlite/schema";
import { backtestJobService } from "../backtest/backtest-job-service";
import {
  buildBacktestIntegrityReport,
  type BacktestIntegrityReport,
} from "../backtest/anti-leakage-report";
import {
  benjaminiHochberg,
  buildStatisticalValidationReport,
  estimateSharpeNullPValue,
  type BacktestStatisticalValidationReport,
  type FalseDiscoveryRateResult,
} from "../backtest/statistical-validation-report";
import {
  buildWhiteRealityCheck,
  type WhiteRealityCheckReport,
} from "../backtest/reality-check";
import { detectRegimeFromBars } from "../market/regime";
import { providerResolver } from "../provider/resolver";
import type {
  BacktestDataset,
  BacktestEquityPoint,
  BacktestMetrics,
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
} from "../provider/types";

export interface WalkForwardParameterCandidate {
  topN?: number;
  rebalance?: "daily" | "weekly" | "monthly";
  longShort?: boolean;
}

export interface WalkForwardSelectionOptions {
  objective?: "sharpe" | "calmar" | "annual_return";
  candidates: WalkForwardParameterCandidate[];
}

export interface WalkForwardRunOptions {
  folds?: number;
  purgeDays?: number;
  embargoDays?: number;
  selection?: WalkForwardSelectionOptions;
}

export interface WalkForwardFoldSelection {
  mode: "train_only_grid";
  objective: "sharpe" | "calmar" | "annual_return";
  candidateCount: number;
  selected: WalkForwardParameterCandidate;
  trainMetrics: BacktestMetrics;
  falseDiscoveryRate: FalseDiscoveryRateResult;
  realityCheck: WhiteRealityCheckReport;
  selectedFdrPass: boolean;
  leaderboard: Array<{
    candidate: WalkForwardParameterCandidate;
    score: number;
    metrics: BacktestMetrics;
    pValue: number | null;
    adjustedPValue: number | null;
    fdrPass: boolean;
  }>;
}

export interface WalkForwardFold {
  fold: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  purgeDays: number;
  embargoDays: number;
  purgeStart: string | null;
  purgeEnd: string | null;
  embargoStart: string | null;
  embargoEnd: string | null;
  metrics: BacktestMetrics;
  sampleSize: number;
  regime: string;
  regimeSource: "market_benchmark" | "benchmark_equity" | "strategy_equity";
  selection?: WalkForwardFoldSelection;
}

export interface WalkForwardEvaluation {
  id: string;
  backtestRunId: string;
  folds: WalkForwardFold[];
  aggregate: {
    foldCount: number;
    compoundedOosReturn: number;
    averageSharpe: number;
    worstMaxDrawdown: number;
    averageTurnover: number;
    positiveFoldRate: number;
    regimeStability: number;
  };
  performancePass: boolean;
  selectionIntegrityPass: boolean;
  integrityReport: BacktestIntegrityReport;
  statisticalValidationReport: BacktestStatisticalValidationReport;
  pass: boolean;
}

export class WalkForwardEvaluationService {
  async run(
    backtestRunId: string,
    options: WalkForwardRunOptions = {}
  ): Promise<WalkForwardEvaluation> {
    const source = await backtestJobService.get(backtestRunId);
    const requestedFolds = Number(options.folds ?? 3);
    const requestedPurgeDays = Number(options.purgeDays ?? 5);
    const requestedEmbargoDays = Number(options.embargoDays ?? 5);
    if (!Number.isFinite(requestedFolds)) throw new Error("walk_forward_folds_invalid");
    if (!Number.isFinite(requestedPurgeDays)) throw new Error("walk_forward_purge_days_invalid");
    if (!Number.isFinite(requestedEmbargoDays)) {
      throw new Error("walk_forward_embargo_days_invalid");
    }
    const foldCount = Math.max(2, Math.min(8, Math.floor(requestedFolds)));
    const purgeDays = Math.max(0, Math.min(30, Math.floor(requestedPurgeDays)));
    const embargoDays = Math.max(0, Math.min(30, Math.floor(requestedEmbargoDays)));
    const windows = createWalkForwardWindows(
      source.config.startDate,
      source.config.endDate,
      foldCount,
      purgeDays,
      embargoDays
    );
    const provider = await providerResolver.resolve<"backtest">(
      "backtest",
      {},
      {
        providerKey: source.engineKey,
      }
    );
    const runner = provider as BacktestProvider;
    if (!runner.run) throw new Error(`provider_${source.engineKey}_lacks_run_method`);
    const selection = normalizeSelection(options.selection);
    const validationExperiment = selection
      ? {
          parameterSelection: "fixed_before_run" as const,
          ...(source.config.experiment?.preRegistrationId
            ? { preRegistrationId: source.config.experiment.preRegistrationId }
            : {}),
          candidateTrials: selection.candidates.length,
        }
      : (source.config.experiment ?? { parameterSelection: "unknown" as const });

    const folds: WalkForwardFold[] = [];
    const oosResults: BacktestResult[] = [];
    for (const window of windows) {
      const selected = selection
        ? await selectOnTrainingWindow(runner, source.config, window, selection)
        : null;
      const testConfig: BacktestRequest = {
        ...source.config,
        ...(selected ? selected.selected : {}),
        startDate: window.testStart,
        endDate: window.testEnd,
        experiment: validationExperiment,
      };
      const result = await runner.run(testConfig);
      if (result.error) throw new Error(`walk_forward_fold_${window.fold}: ${result.error}`);
      oosResults.push(result);
      const regime = await classifyFoldRegime(
        result,
        source.config.benchmark,
        window.testStart,
        window.testEnd,
        source.config.dataset
      );
      folds.push({
        ...window,
        metrics: result.metrics,
        sampleSize: result.meta.sampleSize,
        regime: regime.regime,
        regimeSource: regime.source,
        ...(selected ? { selection: selected } : {}),
      });
    }

    const aggregate = aggregateFolds(folds);
    const selectionIntegrityPass = folds.every(
      (fold) =>
        !fold.selection ||
        (fold.selection.selectedFdrPass && fold.selection.realityCheck.status === "passed")
    );
    const performancePass =
      aggregate.foldCount >= 3 &&
      aggregate.positiveFoldRate >= 0.6 &&
      aggregate.averageSharpe >= 0.3 &&
      aggregate.worstMaxDrawdown <= 0.3 &&
      aggregate.regimeStability >= 0.5;
    const validationConfig: BacktestRequest = {
      ...source.config,
      experiment: validationExperiment,
    };
    const integrityReport = buildBacktestIntegrityReport(validationConfig, {
      runtimeDataIsolated: true,
      nextBarExecution: true,
      oos: { mode: "walk_forward", foldCount: folds.length, purgeDays, embargoDays },
    });
    const statisticalValidationReport = buildStatisticalValidationReport(
      validationConfig,
      stitchOosEquity(oosResults),
      selection ? { trialAnnualizedSharpes: aggregateTrialSharpes(folds) } : {}
    );
    const pass =
      performancePass &&
      selectionIntegrityPass &&
      integrityReport.status === "passed" &&
      statisticalValidationReport.status === "passed";
    const id = await this.persist(
      source,
      folds,
      aggregate,
      performancePass,
      selectionIntegrityPass,
      integrityReport,
      statisticalValidationReport,
      pass
    );
    return {
      id,
      backtestRunId,
      folds,
      aggregate,
      performancePass,
      selectionIntegrityPass,
      integrityReport,
      statisticalValidationReport,
      pass,
    };
  }

  private async persist(
    source: Awaited<ReturnType<typeof backtestJobService.get>>,
    folds: WalkForwardFold[],
    aggregate: WalkForwardEvaluation["aggregate"],
    performancePass: boolean,
    selectionIntegrityPass: boolean,
    integrityReport: BacktestIntegrityReport,
    statisticalValidationReport: BacktestStatisticalValidationReport,
    pass: boolean
  ): Promise<string> {
    const db = await getDb();
    const projectRows = await db
      .select({ projectId: strategy.projectId })
      .from(strategyVersion)
      .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
      .where(eq(strategyVersion.id, source.strategyVersionId))
      .limit(1);
    const projectId = projectRows[0]?.projectId;
    if (!projectId) throw new Error("strategy_project_not_found");
    const rows = await db
      .select({ id: strategyEvalRun.id, evalKind: strategyEvalRun.evalKind })
      .from(strategyEvalRun)
      .where(eq(strategyEvalRun.backtestRunId, source.id));
    const id = rows.find((row) => row.evalKind === "walk_forward")?.id ?? randomUUID();
    const values = {
      metricsJson: {
        aggregate,
        folds,
        performancePass,
        selectionIntegrityPass,
        antiLeakageReport: integrityReport,
        statisticalValidationReport,
        gateVersion: "walk-forward-gate-v5",
      } as never,
      qualityScore: aggregate.regimeStability,
      pass,
      notes: pass
        ? "walk_forward_passed"
        : performancePass && selectionIntegrityPass
          ? `walk_forward_integrity_blocked:${integrityReport.status}/${statisticalValidationReport.status}`
          : !selectionIntegrityPass
            ? "walk_forward_selection_fdr_failed"
            : "walk_forward_performance_gate_failed",
    };
    if (rows.some((row) => row.id === id)) {
      await db.update(strategyEvalRun).set(values).where(eq(strategyEvalRun.id, id));
    } else {
      await db.insert(strategyEvalRun).values({
        id,
        workflowRunId: source.workflowRunId,
        projectId,
        strategyVersionId: source.strategyVersionId,
        compositionId: source.compositionId,
        backtestRunId: source.id,
        scenarioKey: "walk_forward",
        evalKind: "walk_forward",
        periodStart: source.config.startDate,
        periodEnd: source.config.endDate,
        ...values,
        createdBy: "system",
      });
    }
    return id;
  }
}

function normalizeSelection(
  input: WalkForwardSelectionOptions | undefined
): Required<Pick<WalkForwardSelectionOptions, "objective">> &
  Pick<WalkForwardSelectionOptions, "candidates"> | null {
  if (!input) return null;
  if (
    input.objective !== undefined &&
    input.objective !== "sharpe" &&
    input.objective !== "calmar" &&
    input.objective !== "annual_return"
  ) {
    throw new Error("walk_forward_selection_objective_invalid");
  }
  if (!Array.isArray(input.candidates) || input.candidates.length < 2) {
    throw new Error("walk_forward_selection_requires_at_least_2_candidates");
  }
  if (input.candidates.length > 20) {
    throw new Error("walk_forward_selection_max_20_candidates");
  }
  const normalized = input.candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`walk_forward_candidate_${index + 1}_invalid`);
    }
    const topN = candidate.topN;
    if (topN !== undefined && (!Number.isInteger(topN) || topN < 1 || topN > 10_000)) {
      throw new Error(`walk_forward_candidate_${index + 1}_topN_invalid`);
    }
    if (
      candidate.rebalance !== undefined &&
      candidate.rebalance !== "daily" &&
      candidate.rebalance !== "weekly" &&
      candidate.rebalance !== "monthly"
    ) {
      throw new Error(`walk_forward_candidate_${index + 1}_rebalance_invalid`);
    }
    if (candidate.longShort !== undefined && typeof candidate.longShort !== "boolean") {
      throw new Error(`walk_forward_candidate_${index + 1}_long_short_invalid`);
    }
    if (
      topN === undefined &&
      candidate.rebalance === undefined &&
      candidate.longShort === undefined
    ) {
      throw new Error(`walk_forward_candidate_${index + 1}_empty`);
    }
    return {
      ...(topN !== undefined ? { topN } : {}),
      ...(candidate.rebalance ? { rebalance: candidate.rebalance } : {}),
      ...(candidate.longShort !== undefined ? { longShort: candidate.longShort } : {}),
    };
  });
  const unique = new Set(normalized.map((candidate) => JSON.stringify(candidate)));
  if (unique.size !== normalized.length) {
    throw new Error("walk_forward_selection_candidates_must_be_unique");
  }
  return { objective: input.objective ?? "sharpe", candidates: normalized };
}

async function selectOnTrainingWindow(
  runner: BacktestProvider,
  source: BacktestRequest,
  window: ReturnType<typeof createWalkForwardWindows>[number],
  selection: NonNullable<ReturnType<typeof normalizeSelection>>
): Promise<WalkForwardFoldSelection> {
  const rawCandidates: Array<{
    id: string;
    candidate: WalkForwardParameterCandidate;
    score: number;
    metrics: BacktestMetrics;
    pValue: number | null;
    equityCurve: BacktestEquityPoint[];
  }> = [];
  for (const [index, candidate] of selection.candidates.entries()) {
    const result = await runner.run!({
      ...source,
      ...candidate,
      startDate: window.trainStart,
      endDate: window.trainEnd,
      experiment: {
        parameterSelection: "full_sample_optimized",
        candidateTrials: selection.candidates.length,
      },
    });
    if (result.error) {
      throw new Error(`walk_forward_train_fold_${window.fold}: ${result.error}`);
    }
    rawCandidates.push({
      id: `candidate-${index + 1}`,
      candidate,
      score: selectionScore(result.metrics, selection.objective),
      metrics: result.metrics,
      pValue: estimateSharpeNullPValue(result.equityCurve, {
        seedKey: `${source.dataset.snapshotId}:fold-${window.fold}:candidate-${index + 1}`,
      }),
      equityCurve: result.equityCurve,
    });
  }
  const realityCheck = buildWhiteRealityCheck(
    rawCandidates.map((item) => ({ id: item.id, equityCurve: item.equityCurve }))
  );
  const falseDiscoveryRate = benjaminiHochberg(
    rawCandidates.map((item) => ({ id: item.id, pValue: item.pValue }))
  );
  const evidenceById = new Map(
    falseDiscoveryRate.hypotheses.map((item) => [item.id, item] as const)
  );
  const leaderboard: WalkForwardFoldSelection["leaderboard"] = rawCandidates.map((item) => {
    const evidence = evidenceById.get(item.id);
    return {
      candidate: item.candidate,
      score: item.score,
      metrics: item.metrics,
      pValue: item.pValue,
      adjustedPValue: evidence?.adjustedPValue ?? null,
      fdrPass: evidence?.pass ?? false,
    };
  });
  leaderboard.sort((left, right) => right.score - left.score);
  const winner = leaderboard[0];
  if (!winner || !Number.isFinite(winner.score)) {
    throw new Error(`walk_forward_train_fold_${window.fold}: no_finite_candidate_score`);
  }
  return {
    mode: "train_only_grid",
    objective: selection.objective,
    candidateCount: selection.candidates.length,
    selected: winner.candidate,
    trainMetrics: winner.metrics,
    falseDiscoveryRate,
    realityCheck,
    selectedFdrPass: winner.fdrPass,
    leaderboard,
  };
}

function aggregateTrialSharpes(folds: WalkForwardFold[]): number[] {
  const byCandidate = new Map<string, number[]>();
  for (const fold of folds) {
    for (const item of fold.selection?.leaderboard ?? []) {
      const key = JSON.stringify(item.candidate);
      const values = byCandidate.get(key) ?? [];
      if (Number.isFinite(item.metrics.sharpe)) values.push(item.metrics.sharpe);
      byCandidate.set(key, values);
    }
  }
  return [...byCandidate.values()]
    .filter((values) => values.length > 0)
    .map((values) => values.reduce((sum, value) => sum + value, 0) / values.length);
}

function selectionScore(
  metrics: BacktestMetrics,
  objective: WalkForwardFoldSelection["objective"]
): number {
  const value =
    objective === "calmar"
      ? (metrics.calmar ?? Number.NEGATIVE_INFINITY)
      : objective === "annual_return"
        ? metrics.annualReturn
        : metrics.sharpe;
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function stitchOosEquity(results: BacktestResult[]): BacktestEquityPoint[] {
  const stitched: BacktestEquityPoint[] = [];
  let capital = 1;
  for (const result of results) {
    const first = result.equityCurve[0]?.equity;
    if (!first || !Number.isFinite(first) || first <= 0) continue;
    const startIndex = stitched.length === 0 ? 0 : 1;
    for (let index = startIndex; index < result.equityCurve.length; index += 1) {
      const point = result.equityCurve[index];
      if (!point) continue;
      if (!Number.isFinite(point.equity)) continue;
      stitched.push({ date: point.date, equity: capital * (point.equity / first) });
    }
    capital = stitched.at(-1)?.equity ?? capital;
  }
  return stitched;
}

export function createWalkForwardWindows(
  startDate: string,
  endDate: string,
  folds: number,
  purgeDays: number,
  embargoDays = 0
): Array<Omit<WalkForwardFold, "metrics" | "sampleSize" | "regime" | "regimeSource">> {
  const start = dateMs(startDate);
  const end = dateMs(endDate);
  const totalDays = Math.floor((end - start) / 86_400_000) + 1;
  if (totalDays < 30) throw new Error("walk_forward_requires_at_least_30_calendar_days");
  const initialTrainDays = Math.max(15, Math.floor(totalDays / 2));
  const testDays = Math.floor((totalDays - initialTrainDays) / folds);
  if (testDays < 3) throw new Error("walk_forward_test_window_too_short");
  return Array.from({ length: folds }, (_, index) => {
    const testStartMs = start + (initialTrainDays + index * testDays) * 86_400_000;
    const testEndMs = index === folds - 1 ? end : testStartMs + (testDays - 1) * 86_400_000;
    const trainEndMs = testStartMs - (purgeDays + embargoDays + 1) * 86_400_000;
    if (trainEndMs < start) throw new Error("walk_forward_isolation_gap_exceeds_train_window");
    const purgeStartMs = trainEndMs + 86_400_000;
    const purgeEndMs = trainEndMs + purgeDays * 86_400_000;
    const embargoStartMs = purgeEndMs + 86_400_000;
    const embargoEndMs = embargoStartMs + (embargoDays - 1) * 86_400_000;
    return {
      fold: index + 1,
      trainStart: isoDate(start),
      trainEnd: isoDate(trainEndMs),
      testStart: isoDate(testStartMs),
      testEnd: isoDate(testEndMs),
      purgeDays,
      embargoDays,
      purgeStart: purgeDays > 0 ? isoDate(purgeStartMs) : null,
      purgeEnd: purgeDays > 0 ? isoDate(purgeEndMs) : null,
      embargoStart: embargoDays > 0 ? isoDate(embargoStartMs) : null,
      embargoEnd: embargoDays > 0 ? isoDate(embargoEndMs) : null,
    };
  });
}

function aggregateFolds(folds: WalkForwardFold[]): WalkForwardEvaluation["aggregate"] {
  const average = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const profitableRegimes = new Set(
    folds.filter((fold) => fold.metrics.totalReturn > 0).map((fold) => fold.regime)
  );
  const regimes = new Set(folds.map((fold) => fold.regime));
  return {
    foldCount: folds.length,
    compoundedOosReturn:
      folds.reduce((capital, fold) => capital * (1 + fold.metrics.totalReturn), 1) - 1,
    averageSharpe: average(folds.map((fold) => fold.metrics.sharpe)),
    worstMaxDrawdown: Math.max(...folds.map((fold) => fold.metrics.maxDrawdown)),
    averageTurnover: average(folds.map((fold) => fold.metrics.turnover)),
    positiveFoldRate: folds.filter((fold) => fold.metrics.totalReturn > 0).length / folds.length,
    regimeStability: regimes.size > 0 ? profitableRegimes.size / regimes.size : 0,
  };
}

async function classifyFoldRegime(
  result: BacktestResult,
  benchmark: string | undefined,
  startDate: string,
  endDate: string,
  dataset: BacktestDataset
): Promise<{
  regime: string;
  source: WalkForwardFold["regimeSource"];
}> {
  if (benchmark) {
    const marketBars: BarData[] = (dataset.barsBySymbol[benchmark] ?? [])
      .filter((bar) => {
        const date = bar.timestamp.slice(0, 10);
        return date >= startDate && date <= endDate;
      })
      .map((bar) => ({ ...bar, symbol: benchmark, exchange: "" }));
    if (marketBars.length >= 12) {
      return {
        regime: detectRegimeFromBars(marketBars).regime,
        // 保留旧枚举名以兼容已有 UI / 历史记录；数据实际来自绑定快照。
        source: "market_benchmark",
      };
    }
  }
  const useBenchmark = result.equityCurve.some((point) => point.benchmarkEquity != null);
  const bars: BarData[] = result.equityCurve.map((point) => {
    const close = useBenchmark ? (point.benchmarkEquity ?? point.equity) : point.equity;
    return {
      symbol: useBenchmark ? "BENCHMARK" : "STRATEGY_EQUITY",
      exchange: "",
      timestamp: point.date,
      open: close,
      high: close,
      low: close,
      close,
      volume: 0,
      turnover: 0,
    };
  });
  return {
    regime: detectRegimeFromBars(bars).regime,
    source: useBenchmark ? "benchmark_equity" : "strategy_equity",
  };
}

function dateMs(value: string): number {
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(parsed)) throw new Error(`invalid_date: ${value}`);
  return parsed;
}

function isoDate(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

export const walkForwardEvaluationService = new WalkForwardEvaluationService();
