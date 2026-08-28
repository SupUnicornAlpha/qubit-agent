import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { monteCarloService } from "./monte-carlo-service";
import { backtestJobService } from "./backtest-job-service";

describe("Monte Carlo Stress Test & Resampling", () => {
  afterEach(() => {
    mock.restore();
  });

  test("computes reproducible percentiles and risk ratings", async () => {
    const mockEquityCurve = [
      { date: "2026-01-01", equity: 100_000 },
      { date: "2026-01-02", equity: 101_000 },
      { date: "2026-01-03", equity: 102_500 },
      { date: "2026-01-04", equity: 101_800 },
      { date: "2026-01-05", equity: 103_200 },
      { date: "2026-01-06", equity: 104_000 },
      { date: "2026-01-07", equity: 102_000 },
      { date: "2026-01-08", equity: 105_000 },
    ];

    spyOn(backtestJobService, "get").mockResolvedValue({
      id: "job-mc-test",
      engineKey: "event_driven",
      status: "completed",
      config: {
        strategyVersionId: "sv-1",
        symbols: ["AAPL"],
        startDate: "2026-01-01",
        endDate: "2026-01-08",
        capital: 100_000,
        costs: { commissionBps: 5, slippageBps: 5 },
        longShort: false,
        rebalance: "daily",
      },
      result: {
        equityCurve: mockEquityCurve,
        trades: [],
        metrics: {} as any,
        meta: {} as any,
      },
    } as any);

    const input = {
      jobId: "job-mc-test",
      simulations: 200,
      blockSize: 2,
      seed: 42,
    };
    const result = await monteCarloService.run(input);
    const repeated = await monteCarloService.run(input);

    expect(result.simulationCount).toBe(200);
    expect(result.initialCapital).toBe(100_000);
    expect(result.metrics.totalReturnPercentiles).toBeDefined();
    expect(result.metrics.maxDrawdownPercentiles).toBeDefined();
    expect(result.metrics.maxDrawdownPercentiles.p95).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfRuin).toBeGreaterThanOrEqual(0);
    expect(result.probabilityOfRuin).toBeLessThanOrEqual(1);
    expect(result.simulatedPathsSummary.length).toBe(mockEquityCurve.length);
    expect(result.meta.seed).toBe(42);
    expect(repeated.metrics).toEqual(result.metrics);
    expect(repeated.simulatedPathsSummary).toEqual(result.simulatedPathsSummary);
    expect(["low", "moderate", "high", "critical"]).toContain(result.drawdownRiskRating);
  });
});
