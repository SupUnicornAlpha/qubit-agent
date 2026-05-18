import { describe, expect, test } from "bun:test";
import { calcQualityScore, percentile } from "./quality-metrics";

describe("percentile", () => {
  test("returns null for empty input", () => {
    expect(percentile([], 50)).toBeNull();
  });

  test("computes p50 for odd-length samples", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });
});

describe("calcQualityScore", () => {
  test("perfect run stays near 1", () => {
    expect(calcQualityScore({ totalToolCalls: 0, sandboxBlockCount: 0, errorCount: 0 })).toBe(1);
  });

  test("errors and sandbox blocks reduce score", () => {
    const score = calcQualityScore({
      totalToolCalls: 40,
      sandboxBlockCount: 2,
      errorCount: 3,
    });
    expect(score).toBeLessThan(0.75);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
