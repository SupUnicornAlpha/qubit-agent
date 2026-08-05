import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.QUBIT_DATA_DIR = mkdtempSync(
  join(tmpdir(), `prime-monitor-${Date.now()}-`)
);

const { getDb } = await import("../../../db/sqlite/client");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const {
  agentDefinition,
  agentStep,
  llmCallLog,
  mcpCallLog,
  project,
  sandboxPolicy,
  toolCallLog,
  workflowRun,
  workspace,
} = await import("../../../db/sqlite/schema");
const { eq } = await import("drizzle-orm");
const {
  beginCoreMonitorTurn,
  finalizeCoreMonitorTurn,
  recordCoreMonitorToolCall,
} = await import("../project-core-monitor");

describe("project-core-monitor", () => {
  test("writes agent_step + tool_call_log + llm_call_log", async () => {
    await runMigrations();
    const db = await getDb();
    const wsId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const defId = "def-orchestrator";

    await db.insert(workspace).values({
      id: wsId,
      name: "ws",
      owner: "test",
    });
    await db.insert(project).values({
      id: projectId,
      workspaceId: wsId,
      name: "p",
      marketScope: "CN",
    });
    const policy = await db.select().from(sandboxPolicy).limit(1);
    const policyId = policy[0]?.id ?? "default-policy";
    if (!policy[0]) {
      await db.insert(sandboxPolicy).values({
        id: policyId,
        name: "default",
        configJson: {},
      });
    }
    const existingDef = await db
      .select({ id: agentDefinition.id })
      .from(agentDefinition)
      .where(eq(agentDefinition.id, defId))
      .limit(1);
    if (!existingDef[0]) {
      await db.insert(agentDefinition).values({
        id: defId,
        role: "orchestrator",
        executionKind: "primary",
        name: "Orchestrator",
        version: "0.1.0",
        systemPrompt: "",
        toolsJson: [],
        mcpServersJson: [],
        skillsJson: [],
        outputsJson: [],
        subscriptionsJson: [],
        llmProvider: "test",
        maxIterations: 8,
        sandboxPolicyId: policyId,
        enabled: true,
      });
    }
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId,
      goal: "monitor test",
      mode: "research",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const runId = "run-monitor-1";
    const handle = await beginCoreMonitorTurn({
      workflowId,
      runId,
      traceId: "tr-1",
      role: "orchestrator",
      turnId: "trn_1",
    });
    expect(handle.actStepId).toBeTruthy();

    await recordCoreMonitorToolCall({
      workflowId,
      runId,
      toolCallId: "tc_market_1",
      toolName: "market.resolve_symbol",
      ok: true,
      args: { symbol: "AAPL" },
      observation: { summary: "ok" },
    });

    await finalizeCoreMonitorTurn({
      workflowId,
      runId,
      ok: true,
      turn: {
        iteration: 2,
        answer_text: "done",
        llm_stats: {
          sample_count: 2,
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          latency_ms: 42,
          model: "test-model",
          provider: "openai_compatible",
        },
      },
    });

    const tools = await db
      .select()
      .from(toolCallLog)
      .where(eq(toolCallLog.workflowRunId, workflowId));
    expect(tools.length).toBe(1);
    expect(tools[0]?.toolName).toBe("market.resolve_symbol");
    expect(tools[0]?.status).toBe("success");

    const llms = await db
      .select()
      .from(llmCallLog)
      .where(eq(llmCallLog.workflowRunId, workflowId));
    expect(llms.length).toBe(1);
    expect(llms[0]?.model).toBe("test-model");
    expect(llms[0]?.totalTokens).toBe(15);

    const steps = await db
      .select()
      .from(agentStep)
      .where(eq(agentStep.workflowRunId, workflowId));
    expect(steps.length).toBeGreaterThanOrEqual(2);
  });

  test("writes mcp_call_log for Core MCP bridge tools", async () => {
    await runMigrations();
    const db = await getDb();
    const wsId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const workflowId = crypto.randomUUID();
    const defId = "def-orchestrator";

    await db.insert(workspace).values({
      id: wsId,
      name: "ws-mcp",
      owner: "test",
    });
    await db.insert(project).values({
      id: projectId,
      workspaceId: wsId,
      name: "p-mcp",
      marketScope: "CN",
    });
    const policy = await db.select().from(sandboxPolicy).limit(1);
    const policyId = policy[0]?.id ?? "default-policy";
    if (!policy[0]) {
      await db.insert(sandboxPolicy).values({
        id: policyId,
        name: "default",
        configJson: {},
      });
    }
    const existingDef = await db
      .select({ id: agentDefinition.id })
      .from(agentDefinition)
      .where(eq(agentDefinition.id, defId))
      .limit(1);
    if (!existingDef[0]) {
      await db.insert(agentDefinition).values({
        id: defId,
        role: "orchestrator",
        executionKind: "primary",
        name: "Orchestrator",
        version: "0.1.0",
        systemPrompt: "",
        toolsJson: [],
        mcpServersJson: [],
        skillsJson: [],
        outputsJson: [],
        subscriptionsJson: [],
        llmProvider: "test",
        maxIterations: 8,
        sandboxPolicyId: policyId,
        enabled: true,
      });
    }
    await db.insert(workflowRun).values({
      id: workflowId,
      projectId,
      goal: "mcp monitor test",
      mode: "research",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const runId = "run-monitor-mcp-1";
    await beginCoreMonitorTurn({
      workflowId,
      runId,
      traceId: "tr-mcp-1",
      role: "orchestrator",
    });

    await recordCoreMonitorToolCall({
      workflowId,
      runId,
      toolCallId: "tc_mcp_1",
      toolName: "mcp:mathjs:add",
      ok: true,
      args: { a: 1, b: 2 },
      observation: { summary: "ok", output: { result: 3 } },
      mcp: {
        serverName: "mathjs",
        toolName: "add",
        arguments: { a: 1, b: 2 },
        transport: "stdio",
      },
    });

    await finalizeCoreMonitorTurn({
      workflowId,
      runId,
      ok: true,
      turn: { iteration: 1, answer_text: "3" },
    });

    const tools = await db
      .select()
      .from(toolCallLog)
      .where(eq(toolCallLog.id, "tc_mcp_1"));
    expect(tools.length).toBe(1);
    expect(tools[0]?.toolKind).toBe("mcp");
    expect(tools[0]?.status).toBe("success");

    const mcps = await db
      .select()
      .from(mcpCallLog)
      .where(eq(mcpCallLog.id, "tc_mcp_1"));
    expect(mcps.length).toBe(1);
    expect(mcps[0]?.serverName).toBe("mathjs");
    expect(mcps[0]?.toolName).toBe("add");
    expect(mcps[0]?.status).toBe("success");
    expect(mcps[0]?.transport).toBe("stdio");
  });
});
