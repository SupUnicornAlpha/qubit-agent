import { describe, expect, test } from "bun:test";
import type { KlineBar } from "../api/types";
import {
  barsToCandles,
  lineFromSma,
  lineFromValues,
  normalizeKlineBars,
} from "./klineSeries";

function bar(timestamp: string, close: number): KlineBar {
  return {
    symbol: "600519",
    exchange: "SH",
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100,
    turnover: 1_000,
    timestamp,
  };
}

describe("kline series normalization", () => {
  test("sorts bars and keeps the latest duplicate chart bucket", () => {
    const bars = [
      bar("2026-07-27T09:31:40+08:00", 12),
      bar("2026-07-27T09:30:10+08:00", 10),
      bar("2026-07-27T09:30:10+08:00", 11),
    ];

    const normalized = normalizeKlineBars(bars, "1m");

    expect(normalized.map((item) => item.close)).toEqual([11, 12]);
    expect(barsToCandles(bars, "1m")).toHaveLength(2);
  });

  test("deduplicates daily chart dates that have different timestamps", () => {
    const bars = [
      bar("2026-07-27T00:00:00+08:00", 10),
      bar("2026-07-27T15:00:00+08:00", 11),
    ];

    expect(normalizeKlineBars(bars, "1d").map((item) => item.close)).toEqual([11]);
  });

  test("indicator builders remain aligned after duplicate removal", () => {
    const bars = [
      bar("2026-07-27T09:30:00+08:00", 10),
      bar("2026-07-27T09:30:00+08:00", 11),
      bar("2026-07-27T09:31:00+08:00", 12),
      bar("2026-07-27T09:32:00+08:00", 13),
    ];

    expect(lineFromSma(bars, "1m", 2).map((item) => item.value)).toEqual([11.5, 12.5]);
    expect(lineFromValues(bars, "1m", [1, 2, 3, 4]).map((item) => item.value)).toEqual([
      2, 3, 4,
    ]);
  });

  test("drops invalid bars before sending data to the chart", () => {
    const invalid = { ...bar("not-a-date", 10), close: Number.NaN };
    expect(normalizeKlineBars([invalid], "1m")).toEqual([]);
  });
});
