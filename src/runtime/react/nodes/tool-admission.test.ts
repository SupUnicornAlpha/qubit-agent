import { afterEach, describe, expect, test } from "bun:test";
import type { AgentGraphState } from "../state";
import { admitTool } from "./tool-admission";
import type { ToolPlan } from "./tool-plan";

const originalCapabilityGate = process.env.CAPABILITY_GATE_ENABLED;

afterEach(() => {
  if (originalCapabilityGate === undefined) process.env.CAPABILITY_GATE_ENABLED = undefined;
  else process.env.CAPABILITY_GATE_ENABLED = originalCapabilityGate;
});

describe("tool admission", () => {
  test("denies execution in plan mode before sandbox or dispatch", async () => {
    process.env.CAPABILITY_GATE_ENABLED = "0";
    const events: unknown[] = [];
    const result = await admitTool({
      state: {
        runId: "run",
        workflowId: "wf",
        traceId: "trace",
        iteration: 1,
        reasonText: "call a tool",
        contextMemory: {},
        observations: [],
        toolCalls: [],
        agentDefinition: { id: "def", role: "orchestrator" },
        inboundMessage: { payload: {} },
      } as unknown as AgentGraphState,
      emit: (event) => events.push(event),
      plan: {
        requestedToolName: "fuse_signals",
        effectiveToolName: "fuse_signals",
        params: {},
        mcp: undefined,
        executionRoute: null,
        connectorTarget: undefined,
        targetKind: "tool",
        targetName: "fuse_signals",
        toolKind: "builtin",
      } satisfies ToolPlan,
      projectId: undefined,
      agentMode: "plan",
      agentStepId: "step",
      toolCallId: "call",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.patch.observations?.at(-1)).toMatchObject({
      code: "PLAN_MODE_EXECUTION_BLOCKED",
    });
    expect(events).toHaveLength(1);
  });
});
