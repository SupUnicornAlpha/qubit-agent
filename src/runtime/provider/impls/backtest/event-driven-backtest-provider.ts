/**
 * EventDrivenBacktestProvider — 纯 TS 事件驱动回测 Provider
 *
 * 与 sma-legacy 的差异：
 *   - sma_legacy：单股 SMA crossover，bar-by-bar
 *   - event_driven：横截面多 symbol，topN 选股，再平衡，滑点/手续费
 *
 * Signal 解析顺序：
 *   - factor_score：拉所有 symbol 的 OHLCV → 用 FactorComputeProvider 算因子 → 得 daily 横截面分数
 *   - rule        ：暂不支持（M3 之后接 RuleEngineProvider）
 *   - composition ：暂不支持（M3 之后接 StrategyComposer）
 *
 * 这是 M3 的"主 Provider"：priority > sma_legacy。
 */

import type { BacktestProvider, BacktestRequest, BacktestResult, ProviderMeta } from "../../types";
import { buildBacktestIntegrityReport } from "../../../backtest/anti-leakage-report";
import { buildAssetLifecycleReport } from "../../../backtest/asset-lifecycle-model";
import {
  fundamentalFieldName,
  materializeFundamentalPitFields,
} from "../../../backtest/fundamental-pit-series";
import { verifyPointInTimeIntegrity } from "../../../backtest/pit-verifier";
import { buildStatisticalValidationReport } from "../../../backtest/statistical-validation-report";
import {
  assessIntradaySessionCoverage,
  inferIntradayPeriodsPerYear,
  isIntradayTimeframe,
} from "../../../backtest/intraday-session-model";
import { type BarPoint, type EngineInput, runEventEngine } from "./event-engine";
import { ExprEvalError, type PriceSeries, evalExpr } from "../factor/qlib-expr/evaluator";
import { type Ast, parse } from "../factor/qlib-expr/parser";

const FACTOR_AST_CACHE = new Map<string, Ast>();

const META: ProviderMeta = {
  kind: "backtest",
  key: "event_driven",
  displayName: "事件驱动回测（内置纯 TS）",
  description:
    "多 symbol 横截面 topN 等权再平衡 + 滑点 + 双边手续费；下一根 open 撮合避免 lookahead。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "future", "option", "crypto"],
    features: [
      "multi_symbol",
      "cross_section",
      "rebalance_daily_weekly_monthly",
      "long_short",
      "slippage",
      "commission",
      "contract_multiplier",
      "cash_settled_expiry",
      "perpetual_funding",
    ],
    performanceProfile: "batch",
  },
  isBuiltin: true,
  isFallback: false,
};

export class EventDrivenBacktestProvider implements BacktestProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async run(input: BacktestRequest): Promise<BacktestResult> {
    const t0 = Date.now();

    if (input.signals.kind !== "factor_score" && input.signals.kind !== "factor_composite") {
      return this.errorResult(
        t0,
        `event_driven backtest 暂仅支持 factor_score signals；收到 ${input.signals.kind}`
      );
    }

    if (!input.symbols || input.symbols.length === 0) {
      return this.errorResult(t0, "symbols_required");
    }

    const dailyTimeframe = isDailyTimeframe(input.dataset.timeframe);
    const intradayTimeframe = isIntradayTimeframe(input.dataset.timeframe);
    if (!dailyTimeframe && !intradayTimeframe) {
      return this.errorResult(
        t0,
        `timeframe_not_supported:${input.dataset.timeframe || "unknown"}`
      );
    }
    const periodsPerYear = dailyTimeframe ? 252 : inferIntradayPeriodsPerYear(input.dataset);
    if (!dailyTimeframe) {
      const coverage = assessIntradaySessionCoverage(input.dataset);
      if (coverage.length > 0) {
        const first = coverage[0]!;
        return this.errorResult(
          t0,
          `intraday_session_window_unverified:${first.symbol}:${first.timestamp}:${first.code}`
        );
      }
      if (!periodsPerYear) {
        return this.errorResult(t0, "intraday_annualization_unverified");
      }
    }

    const assetLifecycleReport = buildAssetLifecycleReport(input);
    if (assetLifecycleReport.status === "invalid") {
      const failures = assetLifecycleReport.checks
        .filter((check) => check.state === "fail")
        .map((check) => `${check.symbol}:${check.code}`)
        .join(",");
      return this.errorResult(t0, `asset_lifecycle_invalid:${failures}`, assetLifecycleReport);
    }

    // 1) 只消费提交时绑定的数据集。严禁在 Provider 内重新请求市场行情，否则同一
    // config 将随时间漂移，无法复现历史回测。
    const barsByDate = new Map<string, Map<string, BarPoint>>();
    const datesSet = new Set<string>();

    for (const symbol of input.symbols) {
      const bars = (input.dataset.barsBySymbol[symbol] ?? []).filter((bar) => {
        const date = bar.timestamp.slice(0, 10);
        return date >= input.startDate && date <= input.endDate;
      });
      if (!bars || bars.length === 0) {
        return this.errorResult(t0, `dataset_missing_bars:${symbol}`);
      }
      for (const b of bars) {
        const timestamp = b.timestamp;
        const sessionDate = timestamp.slice(0, 10);
        datesSet.add(timestamp);
        let byDate = barsByDate.get(timestamp);
        if (!byDate) {
          byDate = new Map();
          barsByDate.set(timestamp, byDate);
        }
        byDate.set(symbol, {
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
          ...(b.settlementPrice !== undefined ? { settlementPrice: b.settlementPrice } : {}),
          ...(b.fundingRateBps !== undefined ? { fundingRateBps: b.fundingRateBps } : {}),
          ...(b.impliedVolatility !== undefined ? { impliedVolatility: b.impliedVolatility } : {}),
          ...(b.riskFreeRateAnnual !== undefined
            ? { riskFreeRateAnnual: b.riskFreeRateAnnual }
            : {}),
          ...(b.tradable !== undefined ? { tradable: b.tradable } : {}),
          ...(b.suspended !== undefined ? { suspended: b.suspended } : {}),
          ...(b.priceLimitUp !== undefined ? { priceLimitUp: b.priceLimitUp } : {}),
          ...(b.priceLimitDown !== undefined ? { priceLimitDown: b.priceLimitDown } : {}),
          ...(input.dataset.tradingCalendar?.sessionsBySymbol?.[symbol]?.[sessionDate]
            ? {
                calendarSession:
                  input.dataset.tradingCalendar.sessionsBySymbol[symbol]![sessionDate],
              }
            : {}),
        });
      }
    }

    const dates = Array.from(datesSet).sort();
    if (dates.length === 0) {
      return this.errorResult(t0, "no_bars_available");
    }
    const delistings = (input.dataset.corporateActionEvents ?? [])
      .filter((event) => event.kind === "delisting")
      .map((event) => ({
        symbol: event.symbol,
        effectiveDate: event.effectiveDate,
        ...(event.cashAmount !== undefined ? { cashAmount: event.cashAmount } : {}),
      }));
    for (const event of delistings) {
      if (event.effectiveDate < input.startDate || event.effectiveDate > input.endDate) continue;
      const hasSettlement = Number.isFinite(event.cashAmount);
      const hasBar = input.dataset.barsBySymbol[event.symbol]?.some(
        (bar) => bar.timestamp.slice(0, 10) === event.effectiveDate
      );
      if (!hasSettlement && !hasBar) {
        return this.errorResult(
          t0,
          `delisting_settlement_price_missing:${event.symbol}:${event.effectiveDate}`,
          assetLifecycleReport
        );
      }
    }

    // 2) 在同一快照 OHLCV 上计算因子，而非委托可能自行取数的 Provider。
    const unsupportedLang =
      input.signals.kind === "factor_score"
        ? input.signals.lang !== "qlib_expr"
        : input.signals.factors.some((factor) => factor.lang !== "qlib_expr");
    if (unsupportedLang) {
      return this.errorResult(
        t0,
        "snapshot_backtest_unsupported_factor_lang: only qlib_expr is currently deterministic"
      );
    }
    const signals = computeSnapshotSignals(input);

    // 3) 跑事件引擎
    const engineInput: EngineInput = {
      dates,
      bars: barsByDate,
      signals,
      capital: input.capital,
      costs: input.costs,
      rebalance: input.rebalance ?? "daily",
      longShort: input.longShort ?? false,
      reverse: input.signals.kind === "factor_score" ? (input.signals.reverse ?? false) : false,
      periodsPerYear,
      ...(typeof input.topN === "number" && input.topN > 0 ? { topN: input.topN } : {}),
      ...(input.instruments ? { instruments: input.instruments } : {}),
      ...(delistings.length > 0 ? { delistings } : {}),
    };

    // 基准同样只能来自绑定快照。
    if (input.benchmark) {
      const bench = (input.dataset.barsBySymbol[input.benchmark] ?? []).filter((bar) => {
        const date = bar.timestamp.slice(0, 10);
        return date >= input.startDate && date <= input.endDate;
      });
      if (bench) {
        engineInput.benchmarkSeries = bench.map((b) => ({
          date: b.timestamp,
          close: b.close,
        }));
      }
    }

    const result = runEventEngine(engineInput);
    const pitReport = verifyPointInTimeIntegrity(input.dataset);
    const antiLeakageReport = buildBacktestIntegrityReport(input, {
      runtimeDataIsolated: true,
      nextBarExecution: true,
    });
    const statisticalValidationReport = buildStatisticalValidationReport(
      input,
      result.equityCurve,
      {
        periodsPerYear,
      }
    );
    const fundamentalFields = [
      ...new Set(
        (input.dataset.fundamentalObservations ?? []).map((observation) =>
          fundamentalFieldName(observation.metric)
        )
      ),
    ].sort();
    return {
      ...result,
      meta: {
        ...result.meta,
        latencyMs: Date.now() - t0,
        datasetQualification: input.dataset.qualification,
        executionTimeframe: input.dataset.timeframe,
        antiLeakageReport,
        pitReport,
        ...(fundamentalFields.length > 0
          ? {
              fundamentalAvailabilityPolicy: "first_bar_strictly_after_available_at" as const,
              fundamentalFields,
            }
          : {}),
        statisticalValidationReport,
        assetLifecycleReport,
      },
    };
  }

  private errorResult(
    t0: number,
    error: string,
    assetLifecycleReport?: import("../../../backtest/asset-lifecycle-model").AssetLifecycleReport
  ): BacktestResult {
    return {
      equityCurve: [],
      trades: [],
      metrics: {
        totalReturn: 0,
        annualReturn: 0,
        annualVol: 0,
        sharpe: 0,
        maxDrawdown: 0,
        winRate: 0,
        tradeCount: 0,
        turnover: 0,
      },
      meta: {
        latencyMs: Date.now() - t0,
        sampleSize: 0,
        barCount: 0,
        skippedDays: 0,
        ...(assetLifecycleReport ? { assetLifecycleReport } : {}),
      },
      error,
    };
  }
}

function isDailyTimeframe(timeframe: string | undefined): boolean {
  return ["d", "1d", "day", "1day", "daily"].includes((timeframe ?? "").trim().toLowerCase());
}

function computeSnapshotSignals(input: BacktestRequest): Map<string, Map<string, number | null>> {
  if (input.signals.kind !== "factor_score" && input.signals.kind !== "factor_composite") {
    throw new Error(`snapshot_factor_signal_unsupported:${input.signals.kind}`);
  }
  const factors =
    input.signals.kind === "factor_score"
      ? [{ expr: input.signals.expr, weight: 1 }]
      : input.signals.factors;
  const factorSeries = factors.map((factor) => ({
    weight: factor.weight,
    values: computeOneFactorSnapshot(input, factor.expr),
  }));
  if (factorSeries.length === 1) return factorSeries[0]!.values;

  // 因子数值量纲通常不同，因此先逐日截面 rank 标准化到 [-1, 1] 再加权合成。
  const combined = new Map<string, Map<string, { score: number; weight: number }>>();
  for (const factor of factorSeries) {
    for (const [date, values] of factor.values) {
      const ranks = normalizedRanks(values);
      const byDate = combined.get(date) ?? new Map<string, { score: number; weight: number }>();
      for (const [symbol, rank] of ranks) {
        const acc = byDate.get(symbol) ?? { score: 0, weight: 0 };
        acc.score += factor.weight * rank;
        acc.weight += Math.abs(factor.weight);
        byDate.set(symbol, acc);
      }
      combined.set(date, byDate);
    }
  }
  return new Map(
    Array.from(combined, ([date, values]) => [
      date,
      new Map(
        Array.from(values, ([symbol, value]) => [
          symbol,
          value.weight > 1e-12 ? value.score / value.weight : null,
        ])
      ),
    ])
  );
}

function computeOneFactorSnapshot(
  input: BacktestRequest,
  expr: string
): Map<string, Map<string, number | null>> {
  let ast = FACTOR_AST_CACHE.get(expr);
  if (!ast) {
    ast = parse(expr);
    FACTOR_AST_CACHE.set(expr, ast);
  }
  const signals = new Map<string, Map<string, number | null>>();
  for (const symbol of input.symbols) {
    const bars = (input.dataset.barsBySymbol[symbol] ?? []).filter((bar) => {
      const date = bar.timestamp.slice(0, 10);
      return date >= input.startDate && date <= input.endDate;
    });
    const series: PriceSeries = {
      length: bars.length,
      fields: {
        open: bars.map((bar) => bar.open),
        high: bars.map((bar) => bar.high),
        low: bars.map((bar) => bar.low),
        close: bars.map((bar) => bar.close),
        volume: bars.map((bar) => bar.volume),
        turnover: bars.map((bar) => bar.turnover),
        vwap: bars.map((bar) => (bar.volume > 0 ? bar.turnover / bar.volume : bar.close)),
        ...materializeFundamentalPitFields(
          bars,
          input.dataset.fundamentalObservations?.filter(
            (observation) => observation.symbol === symbol
          )
        ),
      },
    };
    let values: Array<number | null>;
    try {
      values = evalExpr(ast, series);
    } catch (error) {
      if (error instanceof ExprEvalError) {
        throw new Error(`snapshot_factor_eval_failed:${symbol}:${error.message}`);
      }
      throw error;
    }
    for (let index = 0; index < bars.length; index += 1) {
      const timestamp = bars[index]!.timestamp;
      const byDate = signals.get(timestamp) ?? new Map<string, number | null>();
      byDate.set(symbol, values[index] ?? null);
      signals.set(timestamp, byDate);
    }
  }
  return signals;
}

function normalizedRanks(values: Map<string, number | null>): Map<string, number> {
  const valid = Array.from(values)
    .filter((entry): entry is [string, number] => entry[1] != null && Number.isFinite(entry[1]))
    .sort((a, b) => a[1] - b[1]);
  const out = new Map<string, number>();
  if (valid.length === 1) {
    out.set(valid[0]![0], 0);
    return out;
  }
  let start = 0;
  while (start < valid.length) {
    let end = start + 1;
    while (end < valid.length && valid[end]![1] === valid[start]![1]) end += 1;
    const averageIndex = (start + end - 1) / 2;
    const normalized = (2 * averageIndex) / (valid.length - 1) - 1;
    for (let index = start; index < end; index += 1) out.set(valid[index]![0], normalized);
    start = end;
  }
  return out;
}
