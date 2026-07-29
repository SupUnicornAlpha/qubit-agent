import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { mcpServerConfig, sandboxPolicy } from "../../db/sqlite/schema";
import type { RuntimeAgentDefinition } from "../types";
import { authorizeCapability, listAuthorizedCapabilities } from "./capability-gate";

function makeDef(
  policyId: string,
  overrides: Partial<RuntimeAgentDefinition> = {}
): RuntimeAgentDefinition {
  return {
    id: `def-gate-${policyId}`,
    role: "market_data",
    name: "t",
    version: "1",
    systemPrompt: "",
    tools: ["fetch_klines", "call_mcp", "update_plan"],
    mcpServers: ["mcp-financex", "mcp-other"],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: policyId,
    enabled: true,
    ...overrides,
  };
}

async function seedPolicy(
  id: string,
  p: { tools?: string[]; mcps?: string[]; connectors?: string[] }
): Promise<void> {
  const db = await getDb();
  await db
    .insert(sandboxPolicy)
    .values({
      id,
      name: id,
      allowedToolsJson: p.tools ?? [],
      allowedMcpServersJson: p.mcps ?? [],
      allowedConnectorsJson: p.connectors ?? [],
    })
    .onConflictDoNothing();
}

async function seedMcp(name: string, enabled: boolean): Promise<void> {
  const db = await getDb();
  await db
    .insert(mcpServerConfig)
    .values({
      id: `mcp-${name}-${enabled ? "on" : "off"}`,
      name,
      transport: "stdio",
      command: "echo",
      capabilitiesJson: { tools: [{ name: "get_kline" }] },
      enabled,
    })
    .onConflictDoNothing();
}

describe("CapabilityGate", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await seedPolicy("gate-pol-open", {
      tools: ["fetch_klines", "call_mcp", "update_plan", "assign_task"],
      mcps: ["mcp-financex", "mcp-other"],
      connectors: ["qubit-data"],
    });
    await seedMcp("mcp-financex", true);
    await seedMcp("mcp-other", false);
  });

  test("authorize denies disabled MCP server with allowlist hint", async () => {
    const def = makeDef("gate-pol-open");
    const decision = await authorizeCapability({
      name: "call_mcp",
      isMcp: true,
      serverName: "mcp-other",
      mcpTool: "get_kline",
      agentDefinition: def,
      workflowId: "wf-gate-1",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("mcp_server_disabled");
    expect(decision.message).toContain("gate_denied");
    expect(decision.allowlist).toContain("mcp-financex");
    expect(decision.allowlist ?? []).not.toContain("mcp-other");
  });

  test("authorize allows enabled MCP on sandbox allowlist", async () => {
    const def = makeDef("gate-pol-open");
    const decision = await authorizeCapability({
      name: "call_mcp",
      isMcp: true,
      serverName: "mcp-financex",
      mcpTool: "get_kline",
      agentDefinition: def,
      workflowId: "wf-gate-2",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.kind).toBe("mcp");
    expect(decision.serverName).toBe("mcp-financex");
  });

  test("plan mode blocks non-update_plan tools", async () => {
    const def = makeDef("gate-pol-open");
    const decision = await authorizeCapability({
      name: "fetch_klines",
      agentDefinition: def,
      workflowId: "wf-gate-3",
      agentMode: "plan",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("plan_mode_blocked");
  });

  test("authorize denies tool not on sandbox allowlist", async () => {
    await seedPolicy("gate-pol-strict-tools", {
      tools: ["update_plan"],
      mcps: ["mcp-financex"],
      connectors: ["qubit-data"],
    });
    const def = makeDef("gate-pol-strict-tools", {
      tools: ["assign_task", "update_plan"],
    });
    const decision = await authorizeCapability({
      name: "assign_task",
      agentDefinition: def,
      workflowId: "wf-gate-sandbox-deny",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("tool_not_allowed");
    expect(decision.message).toContain("gate_denied");
  });

  test("listAuthorizedCapabilities projects enabled MCP only", async () => {
    const def = makeDef("gate-pol-open");
    const surface = await listAuthorizedCapabilities({
      agentDefinition: def,
      workflowId: "wf-gate-4",
    });
    const names = surface.mcpServers.map((s) => s.name);
    expect(names).toContain("mcp-financex");
    expect(names).not.toContain("mcp-other");
  });

  test("listAuthorizedCapabilities plan mode keeps update_plan only", async () => {
    const def = makeDef("gate-pol-open");
    const surface = await listAuthorizedCapabilities({
      agentDefinition: def,
      workflowId: "wf-gate-5",
      agentMode: "plan",
    });
    expect(surface.tools).toEqual(["update_plan"]);
    expect(surface.mcpServers).toEqual([]);
  });
});
