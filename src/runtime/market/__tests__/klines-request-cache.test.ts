import { describe, expect, test } from "bun:test";
import type { BarData } from "../../../connectors/data/data.connector";
import {
  buildKlinesQueryKey,
  clearKlinesRequestCache,
  getCachedKlinesBars,
  setCachedKlinesBars,
} from "../klines-request-cache";

const sampleBars: BarData[] = [
  {
    symbol: "AAPL",
    exchange: "US",
    timestamp: "2026-01-01T00:00:00.000Z",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    turnover: 150,
  },
];

describe("klines-request-cache (C 类冗余)", () => {
  test("workflow 级缓存隔离", () => {
    clearKlinesRequestCache();
    const key = buildKlinesQueryKey({
      symbol: "AAPL",
      exchange: "US",
      period: "1d",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-06-01T00:00:00.000Z",
    });
    setCachedKlinesBars(key, sampleBars, "wf-a");
    expect(getCachedKlinesBars(key, "wf-a")).toEqual(sampleBars);
    expect(getCachedKlinesBars(key, "wf-b")).toBeUndefined();
    clearKlinesRequestCache("wf-a");
    expect(getCachedKlinesBars(key, "wf-a")).toBeUndefined();
  });

  test("global 缓存无 workflow 时仍可命中", () => {
    clearKlinesRequestCache();
    const key = buildKlinesQueryKey({
      symbol: "NVDA",
      period: "1d",
      startDate: "2026-01-01T00:00:00.000Z",
      endDate: "2026-06-01T00:00:00.000Z",
    });
    setCachedKlinesBars(key, sampleBars);
    expect(getCachedKlinesBars(key)).toEqual(sampleBars);
  });
});
