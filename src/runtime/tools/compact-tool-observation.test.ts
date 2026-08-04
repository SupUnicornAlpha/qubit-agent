import { describe, expect, test } from "bun:test";
import {
  compactMarketBarsPayload,
  compactToolObservationValue,
} from "./compact-tool-observation";

describe("compactToolObservationValue", () => {
  test("keeps short bar arrays intact but adds range stats", () => {
    const bars = [
      { timestamp: "2026-01-01", open: 1, high: 2, low: 0.5, close: 1.5 },
      { timestamp: "2026-01-02", open: 1.5, high: 3, low: 1, close: 2.5 },
    ];
    const compact = compactMarketBarsPayload(bars, { keepTail: 40 });
    expect(compact.barCount).toBe(2);
    expect(compact.compacted).toBe(false);
    expect(Array.isArray(compact.bars) && compact.bars).toHaveLength(2);
    expect(compact.range).toMatchObject({ firstClose: 1.5, lastClose: 2.5, high: 3, low: 0.5 });
  });

  test("trims long fetch_klines arrays for prompts", () => {
    const bars = Array.from({ length: 120 }, (_, i) => ({
      timestamp: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`,
      open: i,
      high: i + 1,
      low: i - 1,
      close: i + 0.5,
    }));
    const value = compactToolObservationValue("qubit-data/fetch_klines", bars) as Record<
      string,
      unknown
    >;
    expect(value.barCount).toBe(120);
    expect(value.compacted).toBe(true);
    expect(Array.isArray(value.bars) && value.bars).toHaveLength(40);
  });
});
