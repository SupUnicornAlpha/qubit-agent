import { describe, expect, test } from "bun:test";
import { computeChipDistributionPoint } from "./eastmoney-chip-distribution";

describe("computeChipDistributionPoint", () => {
  test("returns bounded and ordered chip metrics", () => {
    const records = Array.from({ length: 40 }, (_, index) => ({
      date: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
      open: 100 + index * 0.2,
      close: 100.5 + index * 0.2,
      high: 101 + index * 0.2,
      low: 99.5 + index * 0.2,
      turnoverRate: 2,
    }));
    const point = computeChipDistributionPoint(39, records, "TEST", "SH");
    expect(point.winnerRate).toBeGreaterThanOrEqual(0);
    expect(point.winnerRate).toBeLessThanOrEqual(1);
    expect(point.cost90Low).toBeLessThanOrEqual(point.cost90High);
    expect(point.cost70Low).toBeLessThanOrEqual(point.cost70High);
    expect(point.averageCost).toBeGreaterThan(0);
  });
});
