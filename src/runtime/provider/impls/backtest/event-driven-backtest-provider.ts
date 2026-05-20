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

import type { BarData } from "../../../../connectors/data/data.connector";
import { queryBarsRange } from "../../../market/klines-query";
import {
  type BacktestProvider,
  type BacktestRequest,
  type BacktestResult,
  type FactorComputeProvider,
  type ProviderMeta,
} from "../../types";
import { providerResolver } from "../../resolver";
import { type BarPoint, type EngineInput, runEventEngine } from "./event-engine";

const META: ProviderMeta = {
  kind: "backtest",
  key: "event_driven",
  displayName: "事件驱动回测（内置纯 TS）",
  description:
    "多 symbol 横截面 topN 等权再平衡 + 滑点 + 双边手续费；下一根 open 撮合避免 lookahead。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "crypto"],
    features: [
      "multi_symbol",
      "cross_section",
      "rebalance_daily_weekly_monthly",
      "long_short",
      "slippage",
      "commission",
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

    if (input.signals.kind !== "factor_score") {
      return this.errorResult(
        t0,
        `event_driven backtest 暂仅支持 factor_score signals；收到 ${input.signals.kind}`
      );
    }

    if (!input.symbols || input.symbols.length === 0) {
      return this.errorResult(t0, "symbols_required");
    }

    // 1) 拉取 bars
    const barsByDate = new Map<string, Map<string, BarPoint>>();
    const datesSet = new Set<string>();
    const symbolBars = new Map<string, BarData[]>();

    for (const symbol of input.symbols) {
      try {
        const bars = await queryBarsRange({
          symbol,
          exchange: "",
          period: "1d",
          startDate: input.startDate,
          endDate: input.endDate,
        });
        if (bars.length === 0) continue;
        symbolBars.set(symbol, bars);
        for (const b of bars) {
          const d = b.timestamp.slice(0, 10);
          datesSet.add(d);
          let byDate = barsByDate.get(d);
          if (!byDate) {
            byDate = new Map();
            barsByDate.set(d, byDate);
          }
          byDate.set(symbol, {
            open: b.open,
            high: b.high,
            low: b.low,
            close: b.close,
            volume: b.volume,
          });
        }
      } catch {
        continue;
      }
    }

    const dates = Array.from(datesSet).sort();
    if (dates.length === 0) {
      return this.errorResult(t0, "no_bars_available");
    }

    // 2) 算因子分数
    const factorProvider = await providerResolver.resolve("factor_compute", {});
    const computeRes = await (factorProvider as FactorComputeProvider).compute({
      ...(input.signals.factorId ? { factorId: input.signals.factorId } : {}),
      expr: input.signals.expr,
      lang: input.signals.lang,
      universe: input.universe,
      symbols: input.symbols,
      startDate: input.startDate,
      endDate: input.endDate,
    });

    const signals = new Map<string, Map<string, number | null>>();
    for (const row of computeRes.rows) {
      let byDate = signals.get(row.date);
      if (!byDate) {
        byDate = new Map();
        signals.set(row.date, byDate);
      }
      byDate.set(row.symbol, row.value);
    }

    // 3) 跑事件引擎
    const engineInput: EngineInput = {
      dates,
      bars: barsByDate,
      signals,
      capital: input.capital,
      costs: input.costs,
      rebalance: input.rebalance ?? "daily",
      longShort: input.longShort ?? false,
      reverse: input.signals.reverse ?? false,
      ...(typeof input.topN === "number" && input.topN > 0 ? { topN: input.topN } : {}),
    };

    // 基准
    if (input.benchmark) {
      try {
        const bench = await queryBarsRange({
          symbol: input.benchmark,
          exchange: "",
          period: "1d",
          startDate: input.startDate,
          endDate: input.endDate,
        });
        engineInput.benchmarkSeries = bench.map((b) => ({
          date: b.timestamp.slice(0, 10),
          close: b.close,
        }));
      } catch {
        // 基准缺失不影响主流程
      }
    }

    const result = runEventEngine(engineInput);
    return {
      ...result,
      meta: { ...result.meta, latencyMs: Date.now() - t0 },
    };
  }

  private errorResult(t0: number, error: string): BacktestResult {
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
      meta: { latencyMs: Date.now() - t0, sampleSize: 0, barCount: 0, skippedDays: 0 },
      error,
    };
  }
}
