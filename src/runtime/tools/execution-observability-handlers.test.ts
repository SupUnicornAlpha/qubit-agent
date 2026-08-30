import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/sqlite/migrate";
import { SEED_AGENT_DEFINITIONS } from "../seed-agent-definitions-data";
import {
  resetTradingModuleForTest,
  setTradingModuleEnabled,
} from "../trader/trading-module-control";
import { isBuiltinTool } from "./builtin-tools";
import { EXECUTION_OBSERVABILITY_HANDLERS } from "./execution-observability-handlers";
import { ORCHESTRATION_HANDLERS } from "./orchestration-handlers";

beforeAll(async () => {
  await runMigrations();
});

afterEach(async () => {
  await resetTradingModuleForTest();
});

describe("execution observability tool surface", () => {
  test("registers only the read-only monitor tools", () => {
    for (const name of [
      "execution.account.snapshot",
      "execution.order.get",
      "execution.reconcile.positions",
      "execution.kill_switch.status",
      "order.list_open",
      "provider.capabilities",
      "tool.catalog.search",
    ]) {
      expect(isBuiltinTool(name)).toBe(true);
    }
    expect(
      SEED_AGENT_DEFINITIONS.find((item) => item.id === "def-execution-monitor")?.tools
    ).not.toContain("broker_submit_order");
  });

  test("catalog search discovers tools but never grants authorization", async () => {
    const definition = SEED_AGENT_DEFINITIONS.find((item) => item.id === "def-execution-monitor")!;
    const output = (await ORCHESTRATION_HANDLERS["tool.catalog.search"]?.(
      { workflowId: "w", runId: "r", traceId: "t", agentInstanceId: "a", definition },
      { query: "broker", limit: 3 }
    )) as { tools: Array<{ name: string; configuredForThisAgent: boolean }> };
    expect(output.tools.length).toBeGreaterThan(0);
    expect(
      output.tools.some(
        (tool) => tool.name === "execution.order.get" && tool.configuredForThisAgent
      )
    ).toBe(true);
  });

  test("kill-switch status includes the durable trader-module pause", async () => {
    await setTradingModuleEnabled(false, { reason: "test_monitor_pause" });
    const result = (await EXECUTION_OBSERVABILITY_HANDLERS["execution.kill_switch.status"]!(
      {} as never,
      {}
    )) as { clear: boolean; engaged: string[]; tradingModule: { enabled: boolean } };
    expect(result.clear).toBe(false);
    expect(result.engaged).toContain("trading_module");
    expect(result.tradingModule.enabled).toBe(false);
  });
});
