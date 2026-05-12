import { describe, expect, test } from "bun:test";
import { computeNextRunAt, parseMinuteStep, supportsCronExpression } from "./scheduler";

describe("supportsCronExpression", () => {
  test("accepts five-field star cron", () => {
    expect(supportsCronExpression("* * * * *")).toBe(true);
  });

  test("accepts minute step", () => {
    expect(supportsCronExpression("*/5 * * * *")).toBe(true);
  });

  test("rejects wrong field count", () => {
    expect(supportsCronExpression("* * * *")).toBe(false);
  });

  test("rejects non-wildcard hour", () => {
    expect(supportsCronExpression("0 9 * * *")).toBe(false);
  });
});

describe("parseMinuteStep", () => {
  test("star means step 1", () => {
    expect(parseMinuteStep("* * * * *")).toBe(1);
  });

  test("parses */N", () => {
    expect(parseMinuteStep("*/15 * * * *")).toBe(15);
  });

  test("clamps invalid step to at least 1", () => {
    expect(parseMinuteStep("*/0 * * * *")).toBe(1);
  });
});

describe("computeNextRunAt", () => {
  test("throws for unsupported cron", () => {
    expect(() => computeNextRunAt("0 9 * * *")).toThrow();
  });

  test("returns ISO string after from for */1", () => {
    const from = new Date("2026-05-12T10:00:00.000Z");
    const next = computeNextRunAt("* * * * *", from);
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(next).getTime()).toBeGreaterThan(from.getTime());
  });

  test("respects minute step", () => {
    const from = new Date("2026-05-12T10:03:00.000Z");
    const next = computeNextRunAt("*/5 * * * *", from);
    const d = new Date(next);
    expect(d.getUTCMinutes() % 5).toBe(0);
  });
});
