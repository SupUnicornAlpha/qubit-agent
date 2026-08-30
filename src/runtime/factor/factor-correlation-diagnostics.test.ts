import { describe, expect, test } from "bun:test";
import { diagnoseFactorCorrelation } from "./factor-correlation-diagnostics";

function rows(values: number[]) {
  return values.map((value, index) => ({
    symbol: index % 2 === 0 ? "A" : "B",
    date: `2026-01-${String(Math.floor(index / 2) + 1).padStart(2, "0")}`,
    value,
  }));
}

describe("factor correlation diagnostics", () => {
  test("fails an exactly collinear pair on aligned observations", () => {
    const factorA = rows(Array.from({ length: 60 }, (_, index) => index + 1));
    const factorB = rows(Array.from({ length: 60 }, (_, index) => (index + 1) * 3));
    const result = diagnoseFactorCorrelation({
      factorValues: { factor_a: factorA, factor_b: factorB },
    });
    expect(result.status).toBe("failed");
    expect(result.highCorrelationPairs[0]).toMatchObject({ observations: 60, correlation: 1 });
  });

  test("keeps overlap and variance evidence explicit instead of fabricating a correlation", () => {
    const result = diagnoseFactorCorrelation({
      factorValues: { factor_a: rows([1, 2, 3]), factor_b: rows([1, 1, 1]) },
      minimumObservations: 3,
    });
    expect(result.status).toBe("incomplete");
    expect(result.pairs[0]).toMatchObject({
      observations: 3,
      correlation: null,
      status: "constant_series",
    });
  });
});
