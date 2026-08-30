import { expect, test } from "bun:test";
import { MATH_REASONING_HANDLER } from "./math-reasoning-handler";

test("math derivation handler rejects an unadmitted ordinary tool call before parsing or computing", async () => {
  await expect(
    MATH_REASONING_HANDLER(
      {
        workflowId: "workflow-test",
        runId: "run-test",
        traceId: "trace-test",
        agentInstanceId: "agent-test",
        definition: { id: "def-test" } as never,
        inboundPayload: { goal: "随便算一个公式" },
      },
      { contract: {} }
    )
  ).rejects.toThrow("math_harness_not_admitted");
});
