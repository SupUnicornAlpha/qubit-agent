import { describe, expect, test } from "bun:test";
import { assessRuntimeSignalSession } from "./strategy-runtime-worker";

const release = {
  schemaVersion: 1 as const,
  sourceKind: "official_exchange" as const,
  source: "fixture-exchange",
  version: "2026.1",
  venue: "US",
  timezone: "America/New_York",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  effectiveFrom: "2026-01-02",
  effectiveThrough: "2026-01-02",
  sessions: { "2026-01-02": "open" as const },
  sessionWindows: {
    "2026-01-02": [
      { openAt: "2026-01-02T11:00:00.000Z", closeAt: "2026-01-02T12:00:00.000Z" },
    ],
  },
};

describe("strategy runtime execution session", () => {
  test("uses the frozen official release as the live-session authority", () => {
    const now = new Date("2026-01-02T11:30:00.000Z");
    const live = assessRuntimeSignalSession({
      executionMode: "live",
      market: "US",
      params: { calendarRelease: release },
      now,
    });
    const paper = assessRuntimeSignalSession({ executionMode: "paper", market: "US", params: {}, now });

    expect(live.executable).toBe(true);
    expect(live.calendar?.reason).toBe("calendar_open");
    expect(paper.executable).toBe(false);
  });

  test("does not let an omitted official session fall back to generic hours", () => {
    const result = assessRuntimeSignalSession({
      executionMode: "live",
      market: "US",
      params: { calendarRelease: release },
      now: new Date("2026-01-03T15:00:00.000Z"),
    });
    expect(result.executable).toBe(false);
    expect(result.calendar?.reason).toBe("calendar_release_out_of_range");
  });
});
