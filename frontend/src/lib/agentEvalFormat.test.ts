import { describe, expect, test } from "bun:test";
import {
  dailyRollupToChartRows,
  formatAgentEvalScoreValue,
  formatDeltaPct,
} from "./agentEvalFormat";

describe("agentEvalFormat", () => {
  test("formatAgentEvalScoreValue formats numeric scores", () => {
    expect(
      formatAgentEvalScoreValue({
        value: { dataType: "NUMERIC", numeric: 0.8123 },
      })
    ).toBe("0.812");
  });

  test("formatAgentEvalScoreValue formats boolean scores", () => {
    expect(
      formatAgentEvalScoreValue({
        value: { dataType: "BOOLEAN", boolean: true },
      })
    ).toBe("true");
  });

  test("dailyRollupToChartRows pivots by day", () => {
    const rows = dailyRollupToChartRows([
      { day: "2026-08-01", name: "aqm.weighted_score", avgNumeric: 0.5 },
      { day: "2026-08-01", name: "benchmark.overall.score", avgNumeric: 0.7 },
      { day: "2026-08-02", name: "aqm.weighted_score", avgNumeric: 0.6 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.day).toBe("2026-08-01");
    expect(rows[0]?.["aqm.weighted_score"]).toBe(0.5);
    expect(rows[0]?.["benchmark.overall.score"]).toBe(0.7);
  });

  test("formatDeltaPct adds sign", () => {
    expect(formatDeltaPct(12.4)).toBe("+12.4%");
    expect(formatDeltaPct(-8.2)).toBe("-8.2%");
    expect(formatDeltaPct(null)).toBe("—");
  });
});
