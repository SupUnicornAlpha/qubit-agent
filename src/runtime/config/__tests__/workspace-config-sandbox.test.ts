import { describe, expect, test } from "bun:test";
import { buildDefaultSandboxPoliciesFromDefinitions } from "../workspace-config";
import type { RuntimeAgentDefinition } from "../../types";

const defs: RuntimeAgentDefinition[] = [
  {
    id: "def-market",
    role: "market_data",
    name: "行情",
    version: "1",
    systemPrompt: "",
    tools: ["fetch_price_data"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
  {
    id: "def-orch",
    role: "orchestrator",
    name: "编排",
    version: "1",
    systemPrompt: "",
    tools: ["assign_task"],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: "default-policy",
    enabled: true,
  },
];

describe("buildDefaultSandboxPoliciesFromDefinitions", () => {
  test("default-policy 包含 call_team_<role> 拓扑工具", () => {
    const policies = buildDefaultSandboxPoliciesFromDefinitions(defs);
    const p = policies[0];
    expect(p?.allowedTools).toContain("fetch_price_data");
    expect(p?.allowedTools).toContain("assign_task");
    expect(p?.allowedTools).toContain("call_team_market_data");
    expect(p?.allowedTools).toContain("call_team_orchestrator");
  });
});
