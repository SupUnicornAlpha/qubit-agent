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

  test("fails closed when two metric names collapse to the same expression field", () => {
    expect(() =>
      materializeFundamentalPitFields(
        [{ timestamp: "2026-01-02T00:00:00.000Z" }],
        [
          {
            metric: "net income",
            fiscalPeriodEnd: "2025-12-31",
            availableAt: "2026-01-01T00:00:00.000Z",
            value: 1,
          },
          {
            metric: "net-income",
            fiscalPeriodEnd: "2025-12-31",
            availableAt: "2026-01-01T00:00:00.000Z",
            value: 1,
          },
        ]
      )
    ).toThrow(/fundamental_metric_field_collision/);
  });

  test("orders revisions by actual availability across timezone offsets", () => {
    const fields = materializeFundamentalPitFields(
      [{ timestamp: "2026-01-02T00:30:00Z" }, { timestamp: "2026-01-02T09:30:00+08:00" }],
      [
        {
          metric: "revenue",
          fiscalPeriodEnd: "2025-12-31",
          availableAt: "2026-01-02T01:00:00Z",
          value: 105,
        },
        {
          metric: "revenue",
          fiscalPeriodEnd: "2025-12-31",
          availableAt: "2026-01-02T08:00:00+08:00",
          value: 100,
        },
      ]
    );
    expect(fields.fund_revenue).toEqual([100, 105]);
  });

  test("offsets cannot expose a filing early or at the exact availability instant", () => {
    const fields = materializeFundamentalPitFields(
      [
        { timestamp: "2026-01-02T09:00:00+02:00" },
        { timestamp: "2026-01-02T16:00:00+08:00" },
        { timestamp: "2026-01-02T08:00:00.001Z" },
      ],
      [
        {
          metric: "revenue",
          fiscalPeriodEnd: "2025-12-31",
          availableAt: "2026-01-02T08:00:00Z",
          value: 100,
        },
      ]
    );
    expect(fields.fund_revenue).toEqual([null, null, 100]);
  });

  test.each(["2026-01-02T08:00:00", "2026-02-30T08:00:00Z", "invalid"])(
    "rejects an ambiguous or invalid filing timestamp %s",
    (availableAt) => {
      expect(() =>
        materializeFundamentalPitFields(
          [{ timestamp: "2026-03-02T00:00:00Z" }],
          [{ metric: "revenue", fiscalPeriodEnd: "2025-12-31", availableAt, value: 100 }]
        )
      ).toThrow("fundamental_available_at_invalid");
    }
  );

  test("rejects invalid or reversed bar instants instead of carrying future values backward", () => {
    const observations = [
      {
        metric: "revenue",
        fiscalPeriodEnd: "2025-12-31",
        availableAt: "2026-01-02T08:00:00Z",
        value: 100,
      },
    ];
    expect(() =>
      materializeFundamentalPitFields([{ timestamp: "2026-01-03T00:00:00" }], observations)
    ).toThrow("fundamental_bar_timestamp_invalid");
    expect(() =>
      materializeFundamentalPitFields(
        [{ timestamp: "2026-01-02T09:00:00Z" }, { timestamp: "2026-01-02T10:00:00+02:00" }],
        observations
      )
    ).toThrow("fundamental_bar_timestamps_not_increasing");
  });
});
