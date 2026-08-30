import { describe, expect, test } from "bun:test";
import { QlibExprFactorProvider } from "./qlib-expr-factor-provider";

describe("QlibExprFactorProvider point-in-time fundamentals", () => {
  test("materializes fundamental fields only after the frozen observation became available", async () => {
    const result = await new QlibExprFactorProvider().compute({
      factorId: "factor-fundamental",
      expr: "fund_revenue_ttm",
      lang: "qlib_expr",
      universe: "US",
      symbols: ["AAA"],
      startDate: "2026-01-02",
      endDate: "2026-01-06",
      dataset: {
        snapshotId: "snap-fundamental",
        dataRef: "obs-fundamental",
        asOf: "2026-01-06T23:59:59.000Z",
        timeframe: "1d",
        sourceIds: ["fixture"],
        barsBySymbol: {
          AAA: [
            {
              timestamp: "2026-01-02T00:00:00.000Z",
              open: 10,
              high: 11,
              low: 9,
              close: 10,
              volume: 10,
              turnover: 100,
            },
            {
              timestamp: "2026-01-05T00:00:00.000Z",
              open: 10,
              high: 11,
              low: 9,
              close: 10,
              volume: 10,
              turnover: 100,
            },
          ],
        },
        fundamentalObservations: [
          {
            symbol: "AAA",
            metric: "revenue ttm",
            fiscalPeriodEnd: "2025-12-31",
            availableAt: "2026-01-02T20:00:00.000Z",
            value: 100,
          },
        ],
        qualification: {
          useClass: "research_only",
          universeHistory: "not_verified",
          corporateActions: "not_verified",
          pointInTime: "verified",
          limitations: [],
        },
      },
    });

    expect(result.rows.map((row) => row.value)).toEqual([null, 100]);
    expect(result.meta.fundamentalAvailabilityPolicy).toBe("first_bar_strictly_after_available_at");
    expect(result.meta.fundamentalFields).toEqual(["fund_revenue_ttm"]);
  });
});
