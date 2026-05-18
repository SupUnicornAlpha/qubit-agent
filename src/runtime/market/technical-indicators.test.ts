import { describe, expect, test } from "bun:test";
import type { BarData } from "../../connectors/data/data.connector";
import { computeRsi, computeSma, snapshotIndicators } from "./technical-indicators";

function mockBars(closes: number[]): BarData[] {
  return closes.map((close, i) => ({
    symbol: "TEST",
    exchange: "TEST",
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1000,
    turnover: 0,
    timestamp: new Date(Date.UTC(2024, 0, i + 1)).toISOString(),
  }));
}

describe("technical-indicators", () => {
  test("SMA and RSI produce finite tail values", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + i * 0.5);
    const sma20 = computeSma(closes, 20);
    const rsi = computeRsi(closes, 14);
    expect(Number.isFinite(sma20[39])).toBe(true);
    expect(Number.isFinite(rsi[39])).toBe(true);
    expect(rsi[39]).toBeGreaterThan(50);
  });

  test("snapshotIndicators returns structured fields", () => {
    const bars = mockBars(Array.from({ length: 80 }, (_, i) => 50 + Math.sin(i / 5) * 5));
    const snap = snapshotIndicators(bars, "TEST");
    expect(snap.barCount).toBe(80);
    expect(snap.lastClose).toBeGreaterThan(0);
    expect(snap.sma20).not.toBeNull();
  });
});
