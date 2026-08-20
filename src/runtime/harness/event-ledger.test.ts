import { describe, expect, test } from "bun:test";
import { type HarnessEvent, projectHarnessTrace, redactHarnessEventPayload } from "./event-ledger";

function event(
  eventType: HarnessEvent["eventType"],
  payload: Record<string, unknown> = {}
): HarnessEvent {
  return {
    id: crypto.randomUUID(),
    workflowRunId: "wf_ledger_test",
    traceId: "trace_ledger_test",
    turnId: null,
    stepId: null,
    toolCallId: null,
    capabilityId: null,
    profileId: null,
    dedupeKey: null,
    schemaVersion: 1,
    eventType,
    payload,
    createdAt: "2026-08-20T00:00:00.000Z",
  };
}

describe("Harness event ledger projections", () => {
  test("redacts secrets while preserving useful event context", () => {
    const payload = redactHarnessEventPayload({
      toolName: "market.broker_quote.get",
      authorization: "Bearer should-not-be-stored",
      nested: { apiKey: "should-not-be-stored", symbol: "AAPL" },
    });

    expect(payload).toEqual({
      toolName: "market.broker_quote.get",
      authorization: "[redacted]",
      nested: { apiKey: "[redacted]", symbol: "AAPL" },
    });
  });

  test("projects a compact lifecycle summary for Trace and UI consumers", () => {
    const projection = projectHarnessTrace([
      event("capability.composed", { profileIds: ["financial-research"] }),
      event("tool.started", { toolName: "fetch_quote" }),
      event("tool.admitted", { toolName: "fetch_quote" }),
      event("tool.completed", { status: "success" }),
      event("tool.started", { toolName: "fetch_option_chain" }),
      event("tool.rejected", { reason: "sandbox denied" }),
      event("artifact.created", { artifactType: "market.snapshot" }),
    ]);

    expect(projection.summary).toEqual({
      composed: 1,
      degraded: 0,
      admitted: 1,
      rejected: 1,
      started: 2,
      completed: 1,
      artifacts: 1,
      completedByStatus: { success: 1 },
    });
  });
});
