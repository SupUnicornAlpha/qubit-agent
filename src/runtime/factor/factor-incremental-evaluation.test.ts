import { describe, expect, test } from "bun:test";
import { QlibExprFactorProvider } from "../provider/impls/factor/qlib-expr-factor-provider";
import type { BacktestDataset } from "../provider/types";
import { buildIncrementalPreviewSnapshot } from "../research-program/fixtures/incremental-preview";
import {
  type ComparisonFactor,
  averageRanks,
  canonicalExpressionHash,
  correlation,
  evaluateFactorIncrement,
} from "./factor-incremental-evaluation";

async function fixture(
  candidateExpr = "volume",
  referenceExpr = "close / Ref(close, 5) - 1",
  length = 220
) {
  const { record, symbols, startDate, endDate } = buildIncrementalPreviewSnapshot(length);
  const dataset: BacktestDataset = {
    snapshotId: record.snapshot.snapshotId,
    dataRef: "synthetic-only",
    asOf: record.snapshot.asOf,
    timeframe: "1d",
    sourceIds: ["synthetic-preview-only"],
    barsBySymbol: Object.fromEntries(
      symbols.map((s) => [s, record.barsByInstrument[`US:${s}`] ?? []])
    ),
    qualification: {
      useClass: "research_only",
      pointInTime: "not_verified",
      universeHistory: "not_verified",
      corporateActions: "raw_unadjusted",
      limitations: ["synthetic-only"],
    },
  };
  const provider = new QlibExprFactorProvider();
  const factor = async (id: string, expr: string): Promise<ComparisonFactor> => ({
    id,
    name: id,
    expr,
    fingerprint: id,
    direction: 1,
    rows: (
      await provider.compute({
        factorId: id,
        expr,
        lang: "qlib_expr",
        universe: "US",
        symbols,
        startDate,
        endDate,
        dataset,
      })
    ).rows,
  });
  return {
    candidate: await factor("candidate", candidateExpr),
    references: [await factor("reference", referenceExpr)],
    dataset,
    startDate,
    endDate,
    horizonDays: 1,
    method: {
      method: "rank_blend_v1" as const,
      references: [{ factorId: "reference", direction: 1 as const }],
      candidateDirection: 1 as const,
      candidateWeight: 0.25,
      costBps: 10,
    },
  };
}
describe("factor incremental evidence", () => {
  test("ties use average ranks and constant series has no correlation", () => {
    expect(averageRanks([4, 2, 2, 8])).toEqual([2, 0.5, 0.5, 3]);
    expect(correlation([1, 1], [2, 3])).toBeNull();
  });
  test("syntax normalization does not assert unsafe algebraic equivalence", () => {
    expect(canonicalExpressionHash("$close / Ref($close,5)-1")).toBe(
      canonicalExpressionHash(" (close / Ref(close, 5)) - 1 ")
    );
    expect(canonicalExpressionHash("close / close")).not.toBe(canonicalExpressionHash("1"));
  });
  test("equivalent expression is duplicate and fixed allocation has zero increment", async () => {
    const report = evaluateFactorIncrement(await fixture(" $close / Ref($close,5) - 1 "));
    expect(report.verdict).toBe("duplicate");
    expect(report.expression.duplicateFactorIds).toEqual(["reference"]);
    expect(report.signal.pairs[0]?.meanRankCorrelation).toBeCloseTo(1, 9);
    expect(report.portfolio.deltaNetMeanBps).toBeCloseTo(0, 8);
    expect(report.signal.residualRankIc).toBeNull();
  });
  test("positive monotonic transform is caught at signal layer, not invented expression identity", async () => {
    const report = evaluateFactorIncrement(await fixture("2 * (close / Ref(close,5) - 1)"));
    expect(report.expression.duplicateFactorIds).toHaveLength(0);
    expect(report.signal.pairs[0]?.meanAbsoluteRankCorrelation).toBeCloseTo(1, 9);
    expect(report.verdict).toBe("no_incremental_value");
  });
  test("synthetic predictive signal shows descriptive stable increment but never sealed status", async () => {
    const report = evaluateFactorIncrement(await fixture());
    expect(report.verdict).toBe("worth_validation");
    expect(report.scope).toBe("development_only");
    expect(report.portfolio.deltaNetMeanBps ?? 0).toBeGreaterThan(0);
    expect(report.portfolio.stability.every((s) => (s.deltaNetMeanBps ?? 0) > 0)).toBe(true);
    expect(
      (report.portfolio.series[0]?.entryDate ?? "") > (report.portfolio.series[0]?.date ?? "")
    ).toBe(true);
  });
  test("constant, short or sparse candidates cannot be called innovative", async () => {
    expect(evaluateFactorIncrement(await fixture("1")).verdict).toBe("insufficient_evidence");
    expect(evaluateFactorIncrement(await fixture("volume", undefined, 25)).verdict).toBe(
      "insufficient_evidence"
    );
    const input = await fixture();
    input.candidate.rows = input.candidate.rows.filter((r) => r.symbol.endsWith("01"));
    expect(evaluateFactorIncrement(input).verdict).toBe("insufficient_evidence");
  });
  test("longer holding periods do not overlap and labels never escape snapshot end", async () => {
    const input = await fixture();
    input.horizonDays = 5;
    const report = evaluateFactorIncrement(input);
    const series = report.portfolio.series;
    for (let i = 1; i < series.length; i++)
      expect((series[i]?.entryDate ?? "") >= (series[i - 1]?.exitDate ?? "")).toBe(true);
    expect((series.at(-1)?.exitDate ?? "") <= input.endDate).toBe(true);
    expect(report.portfolio.eligiblePeriods).toBe(Math.ceil((220 - 6) / 5));
  });
  test("a missing future price drops a complete period, never redistributes weights to survivors", async () => {
    const input = await fixture();
    const before = evaluateFactorIncrement(input);
    const bar = input.dataset.barsBySymbol.DEMO01?.[50];
    if (bar) bar.open = Number.NaN;
    const after = evaluateFactorIncrement(input);
    expect(after.portfolio.periods).toBeLessThan(before.portfolio.periods);
    const afterDates = new Set(after.portfolio.series.map((p) => p.date));
    const firstRemoved = before.portfolio.series.find((p) => !afterDates.has(p.date));
    expect(firstRemoved).toBeDefined();
  });
  test("observations must be unique and inputs are not mutated by evaluation", async () => {
    const input = await fixture();
    const original = JSON.stringify(input);
    evaluateFactorIncrement(input);
    expect(JSON.stringify(input)).toBe(original);
    const first = input.candidate.rows[0];
    if (first) input.candidate.rows.push(first);
    expect(() => evaluateFactorIncrement(input)).toThrow("duplicate_observation");
  });
});
