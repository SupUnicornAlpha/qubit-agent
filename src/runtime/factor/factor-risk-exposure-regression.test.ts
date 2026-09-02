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
      ledger: {
        version: "1",
        source: "fixture",
        model: "style",
        asOf: "2026-01-03",
        observationsBySymbol: {
          A: [
            {
              effectiveDate: "2026-01-01",
              availableAt: "2026-01-01T00:00:00.000Z",
              exposures: { beta: 1 },
            },
          ],
          B: [
            {
              effectiveDate: "2026-01-01",
              availableAt: "2026-01-01T00:00:00.000Z",
              exposures: { beta: 2 },
            },
          ],
        },
      },
    });
    expect(result.coverageStatus).toBe("passed");
    expect(result.rows[0]).toMatchObject({ exposure: "beta", beta: 2, rSquared: 1 });
    // The new joint diagnostic is advisory until promotion policy explicitly
    // opts into it; existing v1 evidence semantics stay stable.
    expect(result.reasons).toEqual([]);
    expect(result.joint.status).toBe("incomplete");
  });

  test("reports joint Fama–MacBeth coefficients rather than confusing one-control views with neutrality", () => {
    const dates = ["2026-01-02", "2026-01-03", "2026-01-04"];
    const observations = [
      ["A", 0, 0],
      ["B", 1, 0],
      ["C", 0, 1],
      ["D", 1, 1],
    ] as const;
    const result = regressFactorRiskExposures({
      factorId: "f-joint",
      minimumObservations: 12,
      minimumCrossSections: 3,
      values: dates.flatMap((date) =>
        observations.map(([symbol, valueFactor, momentumFactor]) => ({
          symbol,
          date: `${date}T00:00:00.000Z`,
          value: 10 + 2 * valueFactor - 3 * momentumFactor,
        }))
      ),
      ledger: {
        version: "1",
        source: "fixture",
        model: "style",
        asOf: "2026-01-05",
        observationsBySymbol: Object.fromEntries(
          observations.map(([symbol, valueFactor, momentumFactor]) => [
            symbol,
            [
              {
                effectiveDate: "2026-01-01",
                availableAt: "2026-01-01T00:00:00.000Z",
                exposures: { momentum: momentumFactor, value: valueFactor },
              },
            ],
          ])
        ),
      },
    });
    expect(result.version).toBe("factor-risk-exposure-regression-v2");
    expect(result.joint).toMatchObject({
      status: "passed",
      method: "fama_macbeth_cross_sectional_ols_hac_v1",
      eligibleCrossSections: 3,
      commonExposures: ["momentum", "value"],
      meanR2: 1,
    });
    expect(result.joint.coefficients).toEqual([
      expect.objectContaining({ exposure: "momentum", meanBeta: -3, crossSections: 3 }),
      expect.objectContaining({ exposure: "value", meanBeta: 2, crossSections: 3 }),
    ]);
  });

  test("fails closed when common external exposures are rank deficient", () => {
    const dates = ["2026-01-02", "2026-01-03"];
    const observations = [
      ["A", 0],
      ["B", 1],
      ["C", 2],
      ["D", 3],
    ] as const;
    const result = regressFactorRiskExposures({
      factorId: "f-rank-deficient",
      minimumObservations: 8,
      minimumCrossSections: 2,
      values: dates.flatMap((date) =>
        observations.map(([symbol, factor]) => ({
          symbol,
          date: `${date}T00:00:00.000Z`,
          value: factor,
        }))
      ),
      ledger: {
        version: "1",
        source: "fixture",
        model: "style",
        asOf: "2026-01-04",
        observationsBySymbol: Object.fromEntries(
          observations.map(([symbol, factor]) => [
            symbol,
            [
              {
                effectiveDate: "2026-01-01",
                availableAt: "2026-01-01T00:00:00.000Z",
                exposures: { styleA: factor, styleB: factor * 2 },
              },
            ],
          ])
        ),
      },
    });
    expect(result.joint.status).toBe("rank_deficient");
    expect(result.joint.reasons).toContain("risk_exposure_cross_section_rank_deficient");
  });

  test("rejects invalid statistical thresholds even when invoked below the tool layer", () => {
    const input = {
      factorId: "f-invalid-threshold",
      values: [],
      ledger: {
        version: "1",
        source: "fixture",
        model: "style",
        asOf: "2026-01-04",
        observationsBySymbol: {},
      },
    };
    expect(() => regressFactorRiskExposures({ ...input, minimumObservations: 1 })).toThrow(
      "risk_exposure_minimum_observations_invalid"
    );
    expect(() => regressFactorRiskExposures({ ...input, minimumCrossSections: 1 })).toThrow(
      "risk_exposure_minimum_cross_sections_invalid"
    );
  });
});
