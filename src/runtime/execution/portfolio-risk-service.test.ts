import { describe, expect, test } from "bun:test";
import {
  analyzeHistoricalPortfolioRisk,
  buildHistoricalPortfolioRisk,
  runPortfolioStressTests,
} from "./portfolio-risk-service";

describe("portfolio risk", () => {
  test("computes historical VaR, ES, volatility and drawdown", () => {
    const returns = Array.from({ length: 100 }, (_, index) => index % 20 === 0 ? -0.04 : 0.002);
    const metrics = analyzeHistoricalPortfolioRisk(returns)!;
    expect(metrics.observations).toBe(100);
    expect(metrics.historicalVar95Pct).toBeGreaterThanOrEqual(0);
    expect(metrics.expectedShortfall99Pct).toBeGreaterThanOrEqual(metrics.historicalVar99Pct);
    expect(metrics.historicalMaxDrawdownPct).toBeGreaterThan(0);
  });

  test("runs deterministic stress scenarios", () => {
    const stress = runPortfolioStressTests({
      capital: 100_000,
      rows: [{
        symbol: "AAA", side: "long", price: 100, targetWeight: 0.5, targetNotional: 50_000,
        targetQty: 500, currentQty: 0, rebalanceQty: 500, riskContributionPct: 0.02,
        sector: "Tech", beta: 1,
      }],
      candidates: [{ symbol: "AAA", side: "long", price: 100, confidence: 1 }],
    });
    expect(stress.find((row) => row.scenario === "market_crash_20")?.portfolioReturnPct).toBe(-0.1);
    expect(stress.find((row) => row.scenario === "market_crash_20")?.lossAmount).toBe(10_000);
  });

  test("loads aligned bars and records lineage", async () => {
    const risk = await buildHistoricalPortfolioRisk({
      capital: 10_000,
      rows: [{
        symbol: "AAA", side: "long", price: 100, targetWeight: 0.5, targetNotional: 5_000,
        targetQty: 50, currentQty: 0, rebalanceQty: 50, riskContributionPct: 0.02,
        sector: "Tech", beta: 1,
      }],
      candidates: [{ symbol: "AAA", side: "long", price: 100, confidence: 1 }],
      fetchBars: async () => Array.from({ length: 40 }, (_, index) => ({
        timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 1,
      })),
    });
    expect(risk.status).toBe("ready");
    expect(risk.metrics?.observations).toBe(39);
    expect(risk.lineage[0]?.status).toBe("used");
  });

  test("builds historical covariance and correlation matrices", async () => {
    const rows = ["AAA", "BBB"].map((symbol) => ({
      symbol, side: "long" as const, price: 100, targetWeight: 0.4, targetNotional: 4_000,
      targetQty: 40, currentQty: 0, rebalanceQty: 40, riskContributionPct: 0.01,
      sector: "Tech", beta: 1,
    }));
    const risk = await buildHistoricalPortfolioRisk({
      capital: 10_000,
      rows,
      candidates: rows.map((row) => ({ symbol: row.symbol, side: "long" as const, price: 100, confidence: 1 })),
      fetchBars: async ({ symbol }) => Array.from({ length: 40 }, (_, index) => {
        const close = symbol === "AAA" ? 100 + index : 200 + index * 2;
        return {
          timestamp: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
          open: close, high: close, low: close, close, volume: 1,
        };
      }),
    });
    expect(risk.correlationMatrix.AAA?.BBB).toBeGreaterThan(0.99);
    expect(risk.covarianceMatrix.AAA?.BBB).toBeGreaterThan(0);
    expect(risk.weightedAverageCorrelation).toBeGreaterThan(0.99);
  });
});
