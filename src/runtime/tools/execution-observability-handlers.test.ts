import { describe, expect, test } from "bun:test";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import { isBuiltinTool } from "./builtin-tools";
import { ORCHESTRATION_HANDLERS } from "./orchestration-handlers";

describe("execution observability tool surface", () => {
  test("registers only the read-only monitor tools", () => {
    for (const name of [
      "execution.account.snapshot",
      "execution.order.get",
      "execution.reconcile.positions",
      "execution.kill_switch.status",
      "tool.catalog.search",
    ]) {
      expect(isBuiltinTool(name)).toBe(true);
    }
    expect(SEED_AGENT_DEFINITIONS.find((item) => item.id === "def-execution-monitor")?.tools).not.toContain(
      "broker_submit_order"
    );
  });

  test("catalog search discovers tools but never grants authorization", async () => {
    const definition = SEED_AGENT_DEFINITIONS.find((item) => item.id === "def-execution-monitor")!;
    const output = (await ORCHESTRATION_HANDLERS["tool.catalog.search"]!(
      { workflowId: "w", runId: "r", traceId: "t", agentInstanceId: "a", definition },
      { query: "broker", limit: 3 },
    )) as { tools: Array<{ name: string; configuredForThisAgent: boolean }> };
    expect(output.tools.length).toBeGreaterThan(0);
    expect(output.tools.some((tool) => tool.name === "execution.order.get" && tool.configuredForThisAgent)).toBe(true);
  });
});
