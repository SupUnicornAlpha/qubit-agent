import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { sensitivityAnalysisService } from "./sensitivity-analysis-service";
import { backtestJobService } from "./backtest-job-service";
import { providerResolver } from "../provider/resolver";
import type { BacktestProvider, BacktestRequest } from "../provider/types";

describe("Parameter Sensitivity Analysis Service", () => {
  afterEach(() => {
    mock.restore();
  });

  test("generates a research-only parameter scan grid", async () => {
    spyOn(backtestJobService, "get").mockResolvedValueOnce({
      id: "job-sens-test",
      engineKey: "event_driven",
      status: "completed",
      config: {
        strategyVersionId: "sv-1",
        symbols: ["AAPL", "MSFT"],
        startDate: "2026-01-01",
        endDate: "2026-01-10",
        capital: 100_000,
        costs: { commissionBps: 5, slippageBps: 5 },
        longShort: false,
        rebalance: "daily",
        topN: 1,
        signals: { kind: "factor_score", expr: "close", lang: "qlib_expr" },
        dataset: {
          snapshotId: "snap-1",
          dataRef: "market_snapshot/snap-1",
          asOf: "2026-01-10T23:59:59.999Z",
          timeframe: "1d",
          sourceIds: ["us_equity"],
          barsBySymbol: {
            AAPL: [
              { timestamp: "2026-01-01T00:00:00Z", open: 100, high: 102, low: 99, close: 101, volume: 1000, turnover: 101000 },
              { timestamp: "2026-01-02T00:00:00Z", open: 101, high: 103, low: 100, close: 102, volume: 1000, turnover: 102000 },
            ],
            MSFT: [
              { timestamp: "2026-01-01T00:00:00Z", open: 200, high: 202, low: 199, close: 201, volume: 1000, turnover: 201000 },
              { timestamp: "2026-01-02T00:00:00Z", open: 201, high: 203, low: 200, close: 202, volume: 1000, turnover: 202000 },
            ],
          },
          qualification: {
            useClass: "strategy_validation",
            universeHistory: "verified",
            corporateActions: "verified",
            pointInTime: "verified",
            limitations: [],
          },
        },
      },
      result: {
        equityCurve: [
          { date: "2026-01-01", equity: 100_000 },
          { date: "2026-01-10", equity: 105_000 },
        ],
        trades: [],
        metrics: {
          sharpeRatio: 1.5,
          annualizedReturn: 0.15,
          maxDrawdown: 0.05,
          calmarRatio: 3.0,
          winRate: 0.6,
        } as any,
        meta: {} as any,
      },
    } as any);
    spyOn(providerResolver, "resolve").mockResolvedValue({
      run: async (input: BacktestRequest) => ({
        equityCurve: [],
        trades: [],
        metrics: {
          totalReturn: 0.1,
          annualReturn: 0.12,
          annualVol: 0.1,
          sharpe: 2 - input.costs.slippageBps * 0.05 + (input.topN ?? 1) * 0.1,
          maxDrawdown: 0.04,
          calmar: 2.5,
          winRate: 0.55,
          tradeCount: 10,
          turnover: 2,
        },
        meta: { latencyMs: 0, sampleSize: 10, barCount: 20, skippedDays: 0 },
      }),
    } as unknown as BacktestProvider);

    const res = await sensitivityAnalysisService.run({
      jobId: "job-sens-test",
      xParam: { key: "slippageBps", values: [5, 10] },
      yParam: { key: "topN", values: [1, 2] },
    });

    expect(res.grid.length).toBe(2);
    expect(res.grid[0]!.length).toBe(2);
    expect(res.xDimension.values).toEqual([5, 10]);
    expect(res.yDimension.values).toEqual([1, 2]);
    expect(res.optimal).toBeDefined();
    expect(res.optimal.metrics.sharpe).toBeDefined();
    expect(res.stabilityScore).toBeGreaterThan(0);
    expect(res.useClass).toBe("research_only");
    expect(res.parameterSelection).toBe("full_sample_optimized");
    expect(res.integrityWarning).toContain("independent purged OOS");
  });
});
