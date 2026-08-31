import { describe, expect, test } from "bun:test";
import { computeDateRangeForLimit } from "./klines-query";

const D_MS = 24 * 60 * 60 * 1000;

describe("computeDateRangeForLimit", () => {
  test("allocates enough calendar time for the requested number of daily bars", () => {
    const asOf = Date.parse("2026-08-10T12:00:00.000Z");
    const range = computeDateRangeForLimit("1d", 1200, asOf);
    const days = (Date.parse(range.endDate) - Date.parse(range.startDate)) / D_MS;

    expect(range.period).toBe("1d");
    expect(days).toBeGreaterThanOrEqual(1_850);
  });

  test("expands intraday windows past overnight/weekend gaps", () => {
    // Monday morning UTC — a naive 250×5m window (~21h) would sit almost entirely
    // on the weekend and return empty OHLCV from Yahoo.
    const asOf = Date.parse("2026-08-31T10:22:00.000Z");
    const range = computeDateRangeForLimit("5m", 250, asOf);
    const spanMs = Date.parse(range.endDate) - Date.parse(range.startDate);

    expect(range.period).toBe("5m");
    expect(spanMs).toBeGreaterThanOrEqual(7 * D_MS);
    expect(spanMs).toBeLessThanOrEqual(60 * D_MS);
    // Must reach back into the prior trading week (before Fri close).
    expect(Date.parse(range.startDate)).toBeLessThanOrEqual(Date.parse("2026-08-28T20:00:00.000Z"));
  });

  test("keeps a floor lookback even for small intraday limits", () => {
    const asOf = Date.parse("2026-08-31T10:22:00.000Z");
    const range = computeDateRangeForLimit("5m", 24, asOf);
    const spanMs = Date.parse(range.endDate) - Date.parse(range.startDate);
    expect(spanMs).toBeGreaterThanOrEqual(7 * D_MS);
  });
});
