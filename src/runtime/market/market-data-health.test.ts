import { describe, expect, test } from "bun:test";
import { isQuoteFreshForReadiness } from "./market-data-health";

describe("market realtime readiness freshness", () => {
  test("requires a fresh quote during the China trading session", () => {
    const now = new Date("2026-07-27T06:00:00.000Z"); // 14:00 CST
    expect(isQuoteFreshForReadiness("CN", 60_000, now)).toBe(true);
    expect(isQuoteFreshForReadiness("CN", 10 * 60_000, now)).toBe(false);
  });

  test("allows the most recent close outside the China trading session", () => {
    const now = new Date("2026-07-27T10:00:00.000Z"); // 18:00 CST
    expect(isQuoteFreshForReadiness("CN", 3 * 60 * 60_000, now)).toBe(true);
  });

  test("crypto quotes must always be fresh", () => {
    expect(isQuoteFreshForReadiness("CRYPTO", 60_000)).toBe(true);
    expect(isQuoteFreshForReadiness("CRYPTO", 3 * 60_000)).toBe(false);
  });
});
