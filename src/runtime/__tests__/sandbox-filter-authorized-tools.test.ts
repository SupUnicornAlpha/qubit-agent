import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { sandboxPolicy } from "../../db/sqlite/schema";
import { sandboxExecutor } from "../sandbox-executor";
import type { RuntimeAgentDefinition } from "../types";

/**
 * 治理 #1：授权前移到 prompt 组装期。filterAuthorizedTools 必须与 act 阶段
 * check*Call 的判定完全同构：
 *   - builtin / 自定义工具：allowedTools.has(name)
 *   - connector 路由工具（如 fetch_klines→qubit-data）：allowedConnectors 空集=放行，否则 .has(connector)
 *   - MCP server：allowedMcpServers.has(server)
 * 否则 prompt 说可用、act 又拒，反而更糟。
 */

function makeDef(policyId: string, overrides: Partial<RuntimeAgentDefinition> = {}): RuntimeAgentDefinition {
  return {
    id: `def-${policyId}`,
    role: "market_data",
    name: "t",
    version: "1",
    systemPrompt: "",
    tools: [],
    mcpServers: [],
    skills: [],
    subscriptions: ["TASK_ASSIGN"],
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: policyId,
    enabled: true,
    ...overrides,
  };
}

async function seedPolicy(id: string, p: {
  tools?: string[];
  mcps?: string[];
  connectors?: string[];
}): Promise<void> {
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

describe("sandboxExecutor.filterAuthorizedTools", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(async () => {
    await seedPolicy("pol-allow-builtin", { tools: ["assign_task"], mcps: ["mcp-financex"] });
    await seedPolicy("pol-connector-scoped", {
      tools: ["assign_task"],
      connectors: ["qubit-data"],
    });
    await seedPolicy("pol-connector-open", { tools: ["assign_task"], connectors: [] });
  });

  test("builtin 工具：仅保留 allowedTools 命中的；未命中剔除", async () => {
    const def = makeDef("pol-allow-builtin");
    const { tools } = await sandboxExecutor.filterAuthorizedTools(
      def,
      ["assign_task", "edit_agent_pack"],
      []
    );
    expect(tools).toEqual(["assign_task"]);
  });

  test("harness 控制面 update_plan 不受业务工具白名单漂移影响", async () => {
    const def = makeDef("pol-missing-control-policy");
    const { tools } = await sandboxExecutor.filterAuthorizedTools(
      def,
      ["update_plan", "assign_task"],
      []
    );
    expect(tools).toEqual(["update_plan"]);
  });

  test("MCP server：仅保留 allowedMcpServers 命中的", async () => {
    const def = makeDef("pol-allow-builtin");
    const { mcpServers } = await sandboxExecutor.filterAuthorizedTools(
      def,
      [],
      ["mcp-financex", "fsi-factset"]
    );
    expect(mcpServers).toEqual(["mcp-financex"]);
  });

  test("connector 工具 + allowedConnectors 非空：仅命中的 connector 放行", async () => {
    const def = makeDef("pol-connector-scoped");
    // fetch_klines→qubit-data（命中）；submit_order→qubit-broker（未命中）
    const { tools } = await sandboxExecutor.filterAuthorizedTools(
      def,
      ["fetch_klines", "submit_order", "assign_task"],
      []
    );
    expect(tools.sort()).toEqual(["assign_task", "fetch_klines"]);
  });

  test("connector 工具 + allowedConnectors 空集：放行全部 connector 工具", async () => {
    const def = makeDef("pol-connector-open");
    const { tools } = await sandboxExecutor.filterAuthorizedTools(
      def,
      ["fetch_klines", "submit_order", "assign_task"],
      []
    );
    expect(tools.sort()).toEqual(["assign_task", "fetch_klines", "submit_order"]);
  });

  test("缺 policy 行：fail-closed（allowedTools 为空集 → 全剔）", async () => {
    const def = makeDef("pol-missing-row", { tools: ["assign_task"] });
    const { tools } = await sandboxExecutor.filterAuthorizedTools(
      def,
      ["assign_task", "edit_agent_pack"],
      []
    );
    // loadPolicy 缺行时 fail-closed：allowedTools=空集，builtin 全部剔除
    expect(tools).toEqual([]);
  });
});
