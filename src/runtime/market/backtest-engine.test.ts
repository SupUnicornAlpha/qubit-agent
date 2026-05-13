import { describe, expect, test } from "bun:test";
import { runSmaCrossoverBacktest } from "./backtest-engine";
import type { BarData } from "../../connectors/data/data.connector";

function fakeBars(n: number): BarData[] {
  const out: BarData[] = [];
  let price = 100;
  const t0 = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    price += Math.sin(i * 0.2) * 0.4;
    const o = price;
    const c = price + 0.05;
    out.push({
      symbol: "TEST",
      exchange: "X",
      open: o,
      high: Math.max(o, c) + 0.1,
      low: Math.min(o, c) - 0.1,
      close: c,
      volume: 1e6,
      turnover: 0,
      timestamp: new Date(t0 + i * 86_400_000).toISOString(),
    });
  }
  return out;
}

describe("runSmaCrossoverBacktest", () => {
  test("returns equity curve and finite metrics", () => {
    const bars = fakeBars(80);
    const r = runSmaCrossoverBacktest(bars, {
      fastPeriod: 3,
      slowPeriod: 10,
      initialCapital: 10_000,
      commission: 0,
    });
    expect(r.equityCurve.length).toBe(bars.length);
    expect(r.metrics.bars).toBe(80);
    expect(Number.isFinite(r.metrics.totalReturnPct)).toBe(true);
    expect(Number.isFinite(r.metrics.maxDrawdownPct)).toBe(true);
  });
});
