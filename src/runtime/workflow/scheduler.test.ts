import { describe, expect, test } from "bun:test";
import {
  computeNextRunAt,
  executeScheduledJobAction,
  parseMinuteStep,
  parsePositionReconciliationJobPayload,
  parseScheduledJobKind,
  supportsCronExpression,
} from "./scheduler";

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

describe("scheduled job actions", () => {
  test("defaults historical payloads to workflow jobs", () => {
    expect(parseScheduledJobKind({ goal: "研究 AAPL" })).toBe("workflow");
  });

  test("parses position reconciliation payload", () => {
    expect(
      parsePositionReconciliationJobPayload({
        kind: "position_reconciliation",
        provider: "ib",
        accountRef: " DU123 ",
      }),
    ).toEqual({ kind: "position_reconciliation", provider: "ib", accountRef: "DU123" });
    expect(
      parsePositionReconciliationJobPayload({
        kind: "position_reconciliation",
        provider: "invalid",
      }),
    ).toBeNull();
  });

  test("runs reconciliation without creating a workflow", async () => {
    const calls: unknown[] = [];
    const job = {
      id: "job-1",
      workspaceId: "ws-1",
      projectId: "project-1",
      sessionId: null,
      name: "position check",
      enabled: true,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      payloadJson: { kind: "position_reconciliation", provider: "futu", accountRef: "ACC-1" },
      executionMode: "paper",
      nextRunAt: null,
      lastRunAt: null,
      createdBy: "user",
      createdAt: "2026-07-13T00:00:00.000Z",
      updatedAt: "2026-07-13T00:00:00.000Z",
    } as const;
    const result = await executeScheduledJobAction(job, "2026-07-13T00:05:00.000Z", {
      scanPositions: async (input) => {
        calls.push(input);
        return {} as Awaited<ReturnType<typeof import("../execution/position-reconciliation-service").scanPositionReconciliation>>;
      },
      dispatchWorkflow: async () => {
        throw new Error("workflow should not be created");
      },
    });
    expect(result).toEqual({});
    expect(calls).toEqual([{ projectId: "project-1", provider: "futu", accountRef: "ACC-1" }]);
  });
});
