import { describe, expect, test } from "bun:test";
import { regressFactorRiskExposures } from "./factor-risk-exposure-regression";

describe("factor risk exposure regression", () => {
  test("uses only PIT-available external exposures", () => {
    const result = regressFactorRiskExposures({
      factorId: "f1",
      minimumObservations: 2,
      values: [
        { symbol: "A", date: "2026-01-02T00:00:00.000Z", value: 2 },
        { symbol: "B", date: "2026-01-02T00:00:00.000Z", value: 4 },
      ],
      ledger: { version: "1", source: "fixture", model: "style", asOf: "2026-01-03", observationsBySymbol: {
        A: [{ effectiveDate: "2026-01-01", availableAt: "2026-01-01T00:00:00.000Z", exposures: { beta: 1 } }],
        B: [{ effectiveDate: "2026-01-01", availableAt: "2026-01-01T00:00:00.000Z", exposures: { beta: 2 } }],
      } },
    });
    expect(result.coverageStatus).toBe("passed");
    expect(result.rows[0]).toMatchObject({ exposure: "beta", beta: 2, rSquared: 1 });
  });
});
