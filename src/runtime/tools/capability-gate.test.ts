import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
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

  test("disabled financex routes only safe fallback tools through the availability gate", async () => {
    const db = await getDb();
    await db
      .update(mcpServerConfig)
      .set({ enabled: false })
      .where(eq(mcpServerConfig.name, "mcp-financex"));
    const def = makeDef("gate-pol-open");
    const fallback = await authorizeCapability({
      name: "call_mcp",
      isMcp: true,
      serverName: "mcp-financex",
      mcpTool: "get_stock_quote",
      agentDefinition: def,
      workflowId: "wf-gate-financex-fallback",
    });
    expect(fallback.ok).toBe(true);

    const unsupported = await authorizeCapability({
      name: "call_mcp",
      isMcp: true,
      serverName: "mcp-financex",
      mcpTool: "get_options_chain",
      agentDefinition: def,
      workflowId: "wf-gate-financex-no-fallback",
    });
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.code).toBe("mcp_server_disabled");
    await db
      .update(mcpServerConfig)
      .set({ enabled: true })
      .where(eq(mcpServerConfig.name, "mcp-financex"));
  });

  test("disabled financex exposes only the built-in fallback surface to the prompt", async () => {
    const db = await getDb();
    await db
      .update(mcpServerConfig)
      .set({ enabled: false })
      .where(eq(mcpServerConfig.name, "mcp-financex"));
    const surface = await listAuthorizedCapabilities({
      agentDefinition: makeDef("gate-pol-open"),
      workflowId: "wf-gate-financex-surface",
    });
    expect(surface.tools).toContain("call_mcp");
    const financex = surface.mcpServers.find((server) => server.name === "mcp-financex");
    expect(financex?.tools?.map((tool) => tool.name).sort()).toEqual([
      "get_historical_data",
      "get_market_news",
      "get_quote",
      "get_quote_batch",
    ]);
    await db
      .update(mcpServerConfig)
      .set({ enabled: true })
      .where(eq(mcpServerConfig.name, "mcp-financex"));
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

  test("MCP requires its call_mcp entry point to be authorized too", async () => {
    await seedPolicy("gate-pol-no-call-mcp", {
      tools: ["fetch_klines"],
      mcps: ["mcp-financex"],
      connectors: ["qubit-data"],
    });
    const decision = await authorizeCapability({
      name: "call_mcp",
      isMcp: true,
      serverName: "mcp-financex",
      mcpTool: "get_kline",
      agentDefinition: makeDef("gate-pol-no-call-mcp", { tools: ["fetch_klines"] }),
      workflowId: "wf-gate-mcp-entrypoint",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("tool_not_allowed");
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

  test("team tools require an enabled topology target", async () => {
    await seedPolicy("gate-pol-dangling-team", {
      tools: ["call_team_not_a_real_role"],
    });
    const decision = await authorizeCapability({
      name: "call_team_not_a_real_role",
      agentDefinition: makeDef("gate-pol-dangling-team", {
        tools: ["call_team_not_a_real_role"],
      }),
      workflowId: "wf-gate-dangling-team",
    });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.code).toBe("topology_role_blocked");
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
