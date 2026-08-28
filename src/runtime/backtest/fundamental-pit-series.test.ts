import { describe, expect, test } from "bun:test";
import { fundamentalFieldName, materializeFundamentalPitFields } from "./fundamental-pit-series";

describe("point-in-time fundamental expression fields", () => {
  test("uses a filing only after its availability timestamp and keeps later revisions", () => {
    const fields = materializeFundamentalPitFields(
      [
        { timestamp: "2026-01-02T00:00:00.000Z" },
        { timestamp: "2026-01-05T00:00:00.000Z" },
        { timestamp: "2026-01-06T00:00:00.000Z" },
      ],
      [
        {
          metric: "revenue ttm",
          fiscalPeriodEnd: "2025-12-31",
          availableAt: "2026-01-02T20:00:00.000Z",
          value: 100,
          revisionId: "r1",
        },
        {
          metric: "revenue ttm",
          fiscalPeriodEnd: "2025-12-31",
          availableAt: "2026-01-05T20:00:00.000Z",
          value: 105,
          revisionId: "r2",
        },
      ]
    );

    expect(fundamentalFieldName("revenue ttm")).toBe("fund_revenue_ttm");
    expect(fields.fund_revenue_ttm).toEqual([null, 100, 105]);
  });
});
