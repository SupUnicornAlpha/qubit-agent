import { describe, expect, test } from "bun:test";
import type { BacktestDataset } from "../../provider/types";
import { checkFactorTruncation, compareFactorSignalPrefixes } from "../factor-truncation-check";

function dataset(count = 40): BacktestDataset {
  return {
    snapshotId: "frozen-test-snapshot",
    dataRef: "snapshot://test",
    asOf: "2025-03-01T00:00:00.000Z",
    timeframe: "1d",
    sourceIds: ["synthetic-invariant-fixture"],
    qualification: {
      useClass: "research_only",
      universeHistory: "not_verified",
      corporateActions: "raw_unadjusted",
      pointInTime: "not_verified",
      limitations: ["synthetic_fixture"],
    },
    barsBySymbol: Object.fromEntries(
      ["AAA", "BBB"].map((symbol, offset) => [
        symbol,
        Array.from({ length: count }, (_, index) => {
          const close = 10 + index * (offset + 1) + Math.sin(index);
          return {
            timestamp: new Date(Date.UTC(2025, 0, index + 1)).toISOString(),
            open: close - 0.5,
            high: close + 1,
            low: close - 1,
            close,
            volume: 100 + index,
            turnover: close * (100 + index),
          };
        }),
      ])
    ),
  };
}

describe("frozen snapshot factor truncation checks", () => {
  test("causal rolling factors pass with finite coverage and retain explicit limits", () => {
    const input = dataset();
    const before = JSON.stringify(input);
    const report = checkFactorTruncation({ expr: "$close / Mean($close, 5) - 1", dataset: input });
    expect(report.status).toBe("passed");
    expect(report.cutoffs).toHaveLength(3);
    expect(report.checkedSymbols).toEqual(["AAA", "BBB"]);
    expect(report.skippedNullPairs).toBe(24);
    expect(report.uniqueComparedValues).toBe(70);
    expect(report.mismatchCount).toBe(0);
    expect(report.limitations).toContain(
      "sampled_truncation_consistency_is_not_proof_of_no_lookahead"
    );
    expect(JSON.stringify(input)).toBe(before);
    expect(checkFactorTruncation({ expr: "$close / Mean($close, 5) - 1", dataset: input })).toEqual(
      report
    );
  });

  test.each([
    "Ref($close, -1)",
    "Delta($close, 1 - 2)",
    "($close - Ref(Mean($close, 10), -9)) / Ref(Std($close, 10), -9)",
  ])("rejects explicit future dependencies, including future normalization: %s", (expr) => {
    const report = checkFactorTruncation({ expr, dataset: dataset() });
    expect(report.status).toBe("failed");
    expect(report.issues[0]?.code).toBe("future_reference");
    expect(report.comparedValues).toBe(0);
  });

  test.each([
    "Mean($close, 0)",
    "Unsupported($close)",
    "Ref($close, 2.5)",
    "close /",
    "close Ref(close, -1)",
    "close) + Ref(close, -1)",
  ])("invalid or trailing expressions cannot earn a pass: %s", (expr) => {
    expect(checkFactorTruncation({ expr, dataset: dataset() }).status).toBe("failed");
  });

  test.each(["Mean(close, 100)", "$not_a_real_field", "close / 0"])(
    "empty, warmup-only and NaN outputs remain inconclusive: %s",
    (expr) => {
      const report = checkFactorTruncation({ expr, dataset: dataset() });
      expect(report.status).toBe("insufficient_data");
      expect(report.uniqueComparedValues).toBe(0);
      expect(report.skippedNullPairs).toBeGreaterThan(0);
    }
  );

  test("finite observations must cover all symbols and cannot be inflated by repeated cutoffs", () => {
    const short = checkFactorTruncation({ expr: "close", dataset: dataset(5), minComparisons: 10 });
    expect(short.comparedValues).toBeGreaterThanOrEqual(10);
    expect(short.uniqueComparedValues).toBe(8);
    expect(short.status).toBe("insufficient_data");
    const input = dataset();
    input.barsBySymbol.BBB = input.barsBySymbol.BBB?.slice(-1) ?? [];
    expect(checkFactorTruncation({ expr: "close", dataset: input }).status).toBe(
      "insufficient_data"
    );
  });

  test("financial revisions are rematerialized from their historical availability", () => {
    const input = dataset();
    input.fundamentalObservations = ["AAA", "BBB"].flatMap((symbol) => [
      {
        symbol,
        metric: "eps",
        fiscalPeriodEnd: "2024-09-30",
        availableAt: "2025-01-02T12:00:00.000Z",
        value: 2,
      },
      {
        symbol,
        metric: "eps",
        fiscalPeriodEnd: "2024-09-30",
        availableAt: "2025-01-26T12:00:00.000Z",
        value: 3,
      },
      {
        symbol,
        metric: "eps",
        fiscalPeriodEnd: "2024-12-31",
        availableAt: "2025-02-20T12:00:00.000Z",
        value: 4,
      },
    ]);
    const report = checkFactorTruncation({ expr: "$fund_eps / close", dataset: input });
    expect(report.status).toBe("passed");
    expect(report.skippedNullPairs).toBe(12);
    expect(report.mismatchCount).toBe(0);
  });

  test("requires a snapshot and strictly ordered, unique daily bars", () => {
    const input = dataset();
    input.snapshotId = "";
    expect(checkFactorTruncation({ expr: "close", dataset: input }).issues[0]?.code).toBe(
      "dataset_snapshot_required"
    );
    input.snapshotId = "snapshot";
    input.barsBySymbol.AAA?.reverse();
    expect(checkFactorTruncation({ expr: "close", dataset: input }).issues[0]?.code).toBe(
      "invalid_bar_order"
    );
    const duplicate = input.barsBySymbol.BBB?.[0];
    if (!duplicate) throw new Error("Test fixture requires bars");
    input.barsBySymbol.AAA = [duplicate, duplicate];
    expect(checkFactorTruncation({ expr: "close", dataset: input }).status).toBe("failed");
  });

  test("cutoffs must leave future data and requests have a bounded work budget", () => {
    const input = dataset();
    const finalDate = input.barsBySymbol.AAA?.at(-1)?.timestamp.slice(0, 10) ?? "";
    expect(
      checkFactorTruncation({ expr: "close", dataset: input, cutoffs: [finalDate] }).issues[0]?.code
    ).toBe("invalid_cutoffs");
    expect(checkFactorTruncation({ expr: "close", dataset: input, cutoffs: [] }).status).toBe(
      "failed"
    );
    expect(
      checkFactorTruncation({ expr: "close", dataset: input, absoluteTolerance: Number.NaN }).status
    ).toBe("failed");
    expect(checkFactorTruncation({ expr: "close", dataset: input, minComparisons: 0 }).status).toBe(
      "failed"
    );
    expect(checkFactorTruncation({ expr: "Mean(close, 100000)", dataset: input }).status).toBe(
      "unsupported"
    );
    expect(
      checkFactorTruncation({ expr: "close", dataset: { ...input, timeframe: "1h" } }).status
    ).toBe("unsupported");
  });
});

describe("signal prefix comparison detects injected leakage", () => {
  test("global normalization changes historical signals when future observations arrive", () => {
    const prices = [10, 11, 14, 20, 80];
    const normalize = (values: number[]) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return values.map((value) => value / mean);
    };
    const comparison = compareFactorSignalPrefixes({
      symbol: "AAA",
      cutoff: "2025-01-03",
      dates: ["2025-01-01", "2025-01-02", "2025-01-03"],
      fullValues: normalize(prices),
      truncatedValues: normalize(prices.slice(0, 3)),
    });
    expect(comparison.mismatchCount).toBe(3);
    expect(comparison.mismatches.every((row) => row.kind === "value_changed")).toBe(true);
  });

  test("forward returns disappearing at the cutoff are mismatches, not warmup", () => {
    const comparison = compareFactorSignalPrefixes({
      symbol: "AAA",
      cutoff: "2025-01-03",
      dates: ["2025-01-01", "2025-01-02", "2025-01-03"],
      fullValues: [0.1, 0.2, 0.3],
      truncatedValues: [0.1, 0.2, null],
    });
    expect(comparison.mismatchCount).toBe(1);
    expect(comparison.mismatches[0]).toMatchObject({
      date: "2025-01-03",
      kind: "signal_availability_changed",
      truncatedValue: null,
    });
    expect(comparison.skippedNullPairs).toBe(0);
  });

  test("relative and absolute tolerance ignore numeric noise, not a missing signal", () => {
    const comparison = compareFactorSignalPrefixes({
      symbol: "AAA",
      cutoff: "2025-01-06",
      dates: ["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05", "2025-01-06"],
      fullValues: [null, Number.NaN, 1e8, 0, 1, Number.POSITIVE_INFINITY],
      truncatedValues: [null, null, 1e8 + 0.5, 5e-11, 1.01, 2],
    });
    expect(comparison.skippedNullPairs).toBe(2);
    expect(comparison.comparedDates).toHaveLength(3);
    expect(comparison.mismatchCount).toBe(2);
  });

  test("mismatch examples are bounded while the total remains complete", () => {
    const comparison = compareFactorSignalPrefixes({
      symbol: "AAA",
      cutoff: "2025-02-28",
      dates: Array.from({ length: 40 }, (_, index) =>
        new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10)
      ),
      fullValues: Array(40).fill(1),
      truncatedValues: Array(40).fill(2),
    });
    expect(comparison.mismatchCount).toBe(40);
    expect(comparison.mismatches).toHaveLength(20);
  });
});
