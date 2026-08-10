import { describe, expect, test } from "bun:test";
import { computeDateRangeForLimit } from "./klines-query";

describe("computeDateRangeForLimit", () => {
  test("allocates enough calendar time for the requested number of daily bars", () => {
    const asOf = Date.parse("2026-08-10T12:00:00.000Z");
    const range = computeDateRangeForLimit("1d", 1200, asOf);
    const days = (Date.parse(range.endDate) - Date.parse(range.startDate)) / (24 * 60 * 60 * 1000);

    expect(range.period).toBe("1d");
    expect(days).toBeGreaterThanOrEqual(1_850);
  });

  test("keeps intraday requests measured in their native bar duration", () => {
    const asOf = Date.parse("2026-08-10T12:00:00.000Z");
    const range = computeDateRangeForLimit("1h", 12, asOf);
    const hours = (Date.parse(range.endDate) - Date.parse(range.startDate)) / (60 * 60 * 1000);

    expect(hours).toBe(11);
  });
});
