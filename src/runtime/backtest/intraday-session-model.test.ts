import { describe, expect, test } from "bun:test";
import {
  assessIntradaySessionCoverage,
  inferIntradayPeriodsPerYear,
} from "./intraday-session-model";
import type { BacktestDataset } from "../provider/types";

const dataset = (timestamp: string): BacktestDataset => ({
  snapshotId: "snap-intraday",
  dataRef: "obs-intraday",
  asOf: "2026-01-02T22:00:00.000Z",
  timeframe: "5m",
  sourceIds: ["fixture"],
  barsBySymbol: {
    AAPL: [{ timestamp, open: 10, high: 11, low: 9, close: 10, volume: 1_000, turnover: 10_000 }],
  },
  tradingCalendar: {
    version: "NYSE-2026.1",
    timezone: "America/New_York",
    sessionWindowsBySymbol: {
      AAPL: {
        "2026-01-02": [{ openAt: "2026-01-02T14:30:00.000Z", closeAt: "2026-01-02T21:00:00.000Z" }],
      },
    },
  },
  qualification: {
    useClass: "research_only",
    universeHistory: "not_verified",
    corporateActions: "not_verified",
    pointInTime: "verified",
    limitations: [],
  },
});

describe("intraday frozen session coverage", () => {
  test("admits a bar inside the frozen window and derives its annualization frequency", () => {
    const input = dataset("2026-01-02T14:35:00.000Z");
    expect(assessIntradaySessionCoverage(input)).toEqual([]);
    expect(inferIntradayPeriodsPerYear(input)).toBe(19_656);
  });

  test("does not manufacture an early-close or lunch-break session", () => {
    expect(assessIntradaySessionCoverage(dataset("2026-01-02T21:00:00.000Z"))).toEqual([
      expect.objectContaining({ code: "intraday_bar_outside_frozen_session" }),
    ]);
  });
});
