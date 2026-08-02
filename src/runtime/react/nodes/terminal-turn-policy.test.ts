import { describe, expect, test } from "bun:test";
import type { AgentGraphState } from "../state";
import { handleToolNoneAction } from "./terminal-turn-policy";

describe("terminal turn policy", () => {
  test("a non-orchestrator terminal answer completes without database policy reads", async () => {
    const state = {
      runId: "run",
      workflowId: "workflow",
      traceId: "trace",
      iteration: 1,
      reasonText: '## decision\nUse the current evidence.\n<tool_call>{"tool":"none"}</tool_call>',
      observations: [],
      toolCalls: [],
      agentDefinition: { role: "research" },
    } as unknown as AgentGraphState;
    const events: unknown[] = [];

    const result = await handleToolNoneAction({
      state,
      emit: (event) => events.push(event),
      agentMode: "agent",
      processConfig: null,
      planSnapshot: null,
      availableTools: [],
      summary: "ready",
    });

    expect(result.finalResponse?.status).toBe("completed");
    expect(result.finalResponse?.answerText).toContain("Use the current evidence");
    expect(events).toHaveLength(1);
  });
});
