import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { BarData } from "../../connectors/data/data.connector";
import { getDb } from "../../db/sqlite/client";
import { strategy, strategyEvalRun, strategyVersion } from "../../db/sqlite/schema";
import { backtestJobService } from "../backtest/backtest-job-service";
import { queryBarsRange } from "../market/klines-query";
import { detectRegimeFromBars } from "../market/regime";
import { providerResolver } from "../provider/resolver";
import type { BacktestMetrics, BacktestProvider, BacktestResult } from "../provider/types";

export interface WalkForwardFold {
  fold: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  purgeDays: number;
  metrics: BacktestMetrics;
  sampleSize: number;
  regime: string;
  regimeSource: "market_benchmark" | "benchmark_equity" | "strategy_equity";
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
  pass: boolean;
}

export class WalkForwardEvaluationService {
  async run(
    backtestRunId: string,
    options: { folds?: number; purgeDays?: number } = {}
  ): Promise<WalkForwardEvaluation> {
    const source = await backtestJobService.get(backtestRunId);
    const foldCount = Math.max(2, Math.min(8, Math.floor(options.folds ?? 3)));
    const purgeDays = Math.max(0, Math.min(30, Math.floor(options.purgeDays ?? 5)));
    const windows = createWalkForwardWindows(
      source.config.startDate,
      source.config.endDate,
      foldCount,
      purgeDays
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

    const folds: WalkForwardFold[] = [];
    for (const window of windows) {
      const result = await runner.run({
        ...source.config,
        startDate: window.testStart,
        endDate: window.testEnd,
      });
      if (result.error) throw new Error(`walk_forward_fold_${window.fold}: ${result.error}`);
      const regime = await classifyFoldRegime(
        result,
        source.config.benchmark,
        window.testStart,
        window.testEnd
      );
      folds.push({
        ...window,
        metrics: result.metrics,
        sampleSize: result.meta.sampleSize,
        regime: regime.regime,
        regimeSource: regime.source,
      });
    }

    const aggregate = aggregateFolds(folds);
    const pass =
      aggregate.foldCount >= 3 &&
      aggregate.positiveFoldRate >= 0.6 &&
      aggregate.averageSharpe >= 0.3 &&
      aggregate.worstMaxDrawdown <= 0.3 &&
      aggregate.regimeStability >= 0.5;
    const id = await this.persist(source, folds, aggregate, pass);
    return { id, backtestRunId, folds, aggregate, pass };
  }

  private async persist(
    source: Awaited<ReturnType<typeof backtestJobService.get>>,
    folds: WalkForwardFold[],
    aggregate: WalkForwardEvaluation["aggregate"],
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
      metricsJson: { aggregate, folds, gateVersion: "walk-forward-gate-v1" } as never,
      qualityScore: aggregate.regimeStability,
      pass,
      notes: pass ? "walk_forward_passed" : "walk_forward_gate_failed",
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

export function createWalkForwardWindows(
  startDate: string,
  endDate: string,
  folds: number,
  purgeDays: number
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
    const trainEndMs = testStartMs - (purgeDays + 1) * 86_400_000;
    return {
      fold: index + 1,
      trainStart: isoDate(start),
      trainEnd: isoDate(trainEndMs),
      testStart: isoDate(testStartMs),
      testEnd: isoDate(testEndMs),
      purgeDays,
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
  endDate: string
): Promise<{
  regime: string;
  source: WalkForwardFold["regimeSource"];
}> {
  if (benchmark) {
    try {
      const marketBars = await queryBarsRange({
        symbol: benchmark,
        exchange: "",
        period: "1d",
        startDate,
        endDate,
      });
      if (marketBars.length >= 12) {
        return {
          regime: detectRegimeFromBars(marketBars).regime,
          source: "market_benchmark",
        };
      }
    } catch (error) {
      void error;
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
