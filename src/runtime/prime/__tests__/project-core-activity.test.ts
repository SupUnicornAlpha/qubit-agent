import { describe, expect, test } from "bun:test";
import { projectCoreInvocationsFromSnapshot } from "../project-core-to-graph";
import { corePlanToBunSnapshot } from "../project-core-activity";
import { workflowIdFromCoreWorkspace } from "../bridge-run-context";

describe("corePlanToBunSnapshot", () => {
  test("maps Core snake_case plan wire to Bun snapshot", () => {
    const plan = corePlanToBunSnapshot({
      mode: "plan",
      updated_at: "2026-04-01T00:00:00.000Z",
      goal: {
        text: "ship",
        status: "executing",
        completed_steps: 1,
        total_steps: 2,
        success_criteria: ["done"],
      },
      steps: [
        { id: "s1", title: "one", status: "done" },
        { id: "s2", title: "two", status: "in_progress" },
      ],
    });
    expect(plan).not.toBeNull();
    expect(plan?.mode).toBe("plan");
    expect(plan?.updatedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(plan?.goal?.completedSteps).toBe(1);
    expect(plan?.goal?.totalSteps).toBe(2);
    expect(plan?.steps).toHaveLength(2);
    expect(plan?.steps[1]?.status).toBe("in_progress");
  });
});

describe("workflowIdFromCoreWorkspace", () => {
  test("strips wf_ prefix", () => {
    expect(workflowIdFromCoreWorkspace("wf_abc-123")).toBe("abc-123");
    expect(workflowIdFromCoreWorkspace("ws_other")).toBeNull();
  });
});

describe("projectCoreInvocationsFromSnapshot", () => {
  test("tracks running → completed without double-start", async () => {
    const projected = new Map<string, string>();
    const base = {
      workflowRunId: "wf-test",
      runId: "run-1",
      traceId: "tr-1",
      projected,
    };
    await projectCoreInvocationsFromSnapshot({
      ...base,
      invocations: [
        {
          request: {
            invocation_id: "inv_1",
            callee_spec_id: "def-research",
            goal: "look up",
          },
          child_session_id: "ses_child",
          child_turn_id: "trn_pending",
          state: "running",
        },
      ],
    });
    expect(projected.get("inv_1")).toBe("running");

    await projectCoreInvocationsFromSnapshot({
      ...base,
      invocations: [
        {
          request: {
            invocation_id: "inv_1",
            callee_spec_id: "def-research",
            goal: "look up",
          },
          child_session_id: "ses_child",
          child_turn_id: "trn_child",
          state: "completed",
          delivery: { status: "delivered" },
        },
      ],
    });
    expect(projected.get("inv_1")).toBe("completed");

    // Idempotent
    await projectCoreInvocationsFromSnapshot({
      ...base,
      invocations: [
        {
          request: {
            invocation_id: "inv_1",
            callee_spec_id: "def-research",
            goal: "look up",
          },
          state: "completed",
        },
      ],
    });
    expect(projected.size).toBe(1);
  });
});
