import { describe, expect, test } from "bun:test";
import { resolvePnlAttributionWindow } from "./pnl-attributor";

describe("PnlAttributionWorker window", () => {
  test("replays a bounded rolling window for late fills and marks", () => {
    expect(resolvePnlAttributionWindow(new Date("2026-08-31T12:00:00.000Z"))).toEqual({
      fromDay: "2026-08-25",
      toDay: "2026-08-31",
    });
  });

  test("clamps invalid lookback to one day", () => {
    expect(resolvePnlAttributionWindow(new Date("2026-08-31T12:00:00.000Z"), 0)).toEqual({
      fromDay: "2026-08-31",
      toDay: "2026-08-31",
    });
  });
});
