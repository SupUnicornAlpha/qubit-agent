import { describe, expect, test } from "bun:test";
import { registerBuiltinConnectors } from "../../connectors/bootstrap";
import { connectorRegistry } from "../../connectors/registry";
import {
  dispatchBuiltinTool,
  isBuiltinTool,
  isRoutedTool,
  listRegisteredBuiltinTools,
} from "./builtin-tools";
import { buildToolCatalog } from "./tool-catalog";
import { resolveConnectorForTool } from "./tool-routes";

describe("tool routes", () => {
  test("connector routes for market and backtest tools", () => {
    expect(resolveConnectorForTool("fetch_klines")).toBe("qubit-data");
    expect(resolveConnectorForTool("run_backtest")).toBe("qubit-backtest");
    expect(resolveConnectorForTool("compute_factors")).toBe("qubit-research");
    expect(resolveConnectorForTool("evaluate_risk")).toBe("qubit-risk");
  });

  test("builtin tools are not double-routed", () => {
    expect(isRoutedTool("task_decompose")).toBe(false);
    expect(isBuiltinTool("task_decompose")).toBe(true);
    expect(isBuiltinTool("fetch_klines")).toBe(false);
  });
});

describe("builtin tool handlers", () => {
  const ctx = {
    workflowId: "wf-test",
    runId: "run-test",
    traceId: "trace-test",
    agentInstanceId: "inst-test",
    projectId: "proj-test",
    definition: {
      id: "def-test",
      role: "orchestrator" as const,
      name: "test",
      version: "1",
      systemPrompt: "",
      tools: ["task_decompose"],
      mcpServers: [],
      skills: [],
      subscriptions: [],
      llmProvider: "mock",
      maxIterations: 5,
      sandboxPolicyId: "default-policy",
      enabled: true,
    },
    reasonText: "分析 AAPL",
    inboundPayload: { goal: "分析 AAPL 趋势" },
  };

  test("task_decompose returns steps", async () => {
    const result = (await dispatchBuiltinTool("task_decompose", ctx, {})) as {
      steps: unknown[];
      goal: string;
    };
    expect(result.steps.length).toBeGreaterThan(0);
    expect(result.goal).toContain("AAPL");
  });

  test("catalog includes builtin and connector entries", () => {
    const catalog = buildToolCatalog();
    expect(catalog.some((e) => e.name === "fetch_klines" && e.kind === "connector")).toBe(true);
    expect(catalog.some((e) => e.name === "run_analyst_team" && e.kind === "builtin")).toBe(true);
    expect(listRegisteredBuiltinTools().length).toBeGreaterThan(10);
  });
});

describe("connector bootstrap", () => {
  test("registers all qubit-* connectors", async () => {
    await registerBuiltinConnectors();
    expect(connectorRegistry.get("qubit-data")).toBeDefined();
    expect(connectorRegistry.get("qubit-news")).toBeDefined();
    expect(connectorRegistry.get("qubit-backtest")).toBeDefined();
    expect(connectorRegistry.get("qubit-research")).toBeDefined();
    expect(connectorRegistry.get("qubit-sim")).toBeDefined();
    expect(connectorRegistry.get("qubit-risk")).toBeDefined();
    expect(connectorRegistry.get("qubit-broker")).toBeDefined();
  });
});
