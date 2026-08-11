import { describe, expect, test } from "bun:test";
import type { BarData } from "../../connectors/data/data.connector";
import { detectRegimeFromBars } from "./regime";

function bars(closes: number[]): BarData[] {
  return closes.map((close, index) => ({
    symbol: "TEST",
    exchange: "US",
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    turnover: close,
    timestamp: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  }));
}

describe("detectRegimeFromBars", () => {
  test("returns unknown until enough bars are available", () => {
    expect(detectRegimeFromBars(bars(Array(11).fill(100))).regime).toBe("unknown");
  });

  test("classifies a calm rising series", () => {
    const result = detectRegimeFromBars(
      bars(Array.from({ length: 12 }, (_, i) => 100 + i * 0.4))
    );
    expect(result.regime).toBe("uptrend_calm");
    expect(result.features.return10).toBeGreaterThan(0.03);
  });
});
