import { describe, expect, test } from "bun:test";
import type { StepStreamEvent } from "../../api/types";
import { buildChatExecutionActivity, groupChatExecutionActivities } from "./ChatExecutionActivity";

const event = (
  type: StepStreamEvent["type"],
  payload: Record<string, unknown>
): StepStreamEvent => ({
  runId: "run-1",
  workflowId: "workflow-1",
  traceId: "trace-1",
  role: "orchestrator",
  type,
  stepIndex: 1,
  ts: Date.now(),
  payload,
  source: "a2a",
});

describe("buildChatExecutionActivity", () => {
  test("pairs tool start/end and exposes the A2A execution state", () => {
    const model = buildChatExecutionActivity(
      [
        event("tool_call_start", {
          toolCallId: "call-1",
          targetName: "call_team_market_data",
        }),
        event("tool_call_end", {
          toolCallId: "call-1",
          targetName: "call_team_market_data",
          status: "success",
        }),
      ],
      false
    );

    expect(model.a2a).toEqual({ role: "orchestrator", status: "completed" });
    expect(model.tools).toHaveLength(1);
    expect(model.tools[0]?.name).toBe("call_team_market_data");
    expect(model.tools[0]?.status).toBe("success");
  });

  test("groups adjacent identical polling calls without changing total activity", () => {
    const model = buildChatExecutionActivity(
      [
        event("tool_call_end", { toolCallId: "call-1", targetName: "market.resolve_symbol" }),
        event("tool_call_end", { toolCallId: "call-2", targetName: "market.resolve_symbol" }),
        event("tool_call_end", { toolCallId: "call-3", targetName: "market.snapshot.get" }),
      ],
      false
    );
    const groups = groupChatExecutionActivities(model.tools);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.count).toBe(2);
    expect(groups[1]?.count).toBe(1);
  });
});
