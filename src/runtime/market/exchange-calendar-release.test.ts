import { describe, expect, test } from "bun:test";
import {
  assessExchangeCalendarSession,
  parseExchangeCalendarRelease,
} from "./exchange-calendar-release";

const release = {
  schemaVersion: 1,
  sourceKind: "official_exchange",
  source: "NYSE trading calendar",
  version: "nyse-2026.01.01",
  venue: "US",
  timezone: "America/New_York",
  retrievedAt: "2025-12-01T00:00:00.000Z",
  effectiveFrom: "2026-01-01",
  effectiveThrough: "2026-01-03",
  sessions: { "2026-01-01": "closed", "2026-01-02": "open", "2026-01-03": "closed" },
  sessionWindows: {
    "2026-01-02": [{ openAt: "2026-01-02T14:30:00.000Z", closeAt: "2026-01-02T18:00:00.000Z" }],
  },
} as const;

describe("exchange calendar release", () => {
  test("keeps provenance and exact early-close windows together", () => {
    expect(parseExchangeCalendarRelease(release)).toEqual(expect.objectContaining({ ok: true }));
    expect(
      assessExchangeCalendarSession({
        release,
        venue: "US",
        now: new Date("2026-01-02T17:59:59.000Z"),
      })
    ).toEqual(expect.objectContaining({ executable: true, sessionDate: "2026-01-02" }));
    expect(
      assessExchangeCalendarSession({
        release,
        venue: "US",
        now: new Date("2026-01-02T18:00:00.000Z"),
      })
    ).toEqual(
      expect.objectContaining({ executable: false, reason: "calendar_outside_session_window" })
    );
  });

  test("fails closed for omitted dates, closures and an incompatible venue", () => {
    expect(
      assessExchangeCalendarSession({
        release,
        venue: "US",
        now: new Date("2026-01-01T16:00:00.000Z"),
      }).reason
    ).toBe("calendar_closed");
    expect(
      assessExchangeCalendarSession({
        release: { ...release, sessions: { "2026-01-01": "closed", "2026-01-02": "open" } },
        venue: "US",
        now: new Date("2026-01-03T16:00:00.000Z"),
      }).reason
    ).toBe("calendar_session_missing");
    expect(
      assessExchangeCalendarSession({
        release,
        venue: "CN",
        now: new Date("2026-01-02T16:00:00.000Z"),
      }).reason
    ).toBe("calendar_release_venue_mismatch");
  });
});
