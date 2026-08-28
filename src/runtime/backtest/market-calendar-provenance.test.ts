import { describe, expect, test } from "bun:test";
import { assessTradingCalendarProvenance } from "./market-calendar-provenance";

describe("trading calendar provenance", () => {
  test("does not infer a calendar when a snapshot has no version", () => {
    const checks = assessTradingCalendarProvenance({ timezone: "America/New_York" });

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "calendar_version_missing" })])
    );
  });

  test("accepts a frozen calendar version and IANA timezone", () => {
    expect(
      assessTradingCalendarProvenance({
        version: "NYSE-2026.1",
        timezone: "America/New_York",
        sessionsBySymbol: { AAPL: { "2026-01-02": "open" } },
      })
    ).toEqual([expect.objectContaining({ state: "pass", code: "calendar_provenance_valid" })]);
  });

  test("warns on an invalid timezone instead of accepting a guessed session boundary", () => {
    const checks = assessTradingCalendarProvenance({
      version: "CN-2026.1",
      timezone: "Mars/Olympus",
    });

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "calendar_timezone_invalid" })])
    );
  });

  test("requires explicit session states rather than assuming every calendar day is open", () => {
    const checks = assessTradingCalendarProvenance({
      version: "NYSE-2026.1",
      timezone: "America/New_York",
    });

    expect(checks).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "calendar_sessions_missing" })])
    );
  });
});
