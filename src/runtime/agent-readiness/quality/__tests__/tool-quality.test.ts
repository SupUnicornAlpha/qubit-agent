/**
 * B 类 · 工具/Skill 调用质量（B-1 必备召回 / B-2 参数合理 / B-3 失败率 / B-7 重复调用）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-aqm-tool-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../../db/sqlite/migrate");
const { getDb, closeDb, getSqliteForTesting } = await import(
  "../../../../db/sqlite/client"
);
const schema = await import("../../../../db/sqlite/schema");
const { collectToolQuality } = await import("../tool-quality");

const WORKSPACE_ID = "ws-aqm-tool";
const PROJECT_ID = "proj-aqm-tool";
const SANDBOX_ID = "sb-aqm-tool";

async function setupWfWithStep(): Promise<{ wfId: string; stepId: string }> {
  const db = await getDb();
  const wfId = `wf-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id: wfId,
    projectId: PROJECT_ID,
    sessionId: null,
    goal: "tool quality",
    mode: "research",
    source: "api",
    status: "completed",
  });
  const defId = `def-${wfId}`;
  await db.insert(schema.agentDefinition).values({
    id: defId,
    role: "orchestrator",
    name: "tq-def",
    version: "v1",
    systemPrompt: "",
    toolsJson: [] as never,
    mcpServersJson: [] as never,
    skillsJson: [] as never,
    subscriptionsJson: [] as never,
    llmProvider: "mock",
    maxIterations: 6,
    sandboxPolicyId: SANDBOX_ID,
    enabled: true,
  });
  const instId = `inst-${wfId}`;
  await db.insert(schema.agentInstance).values({
    id: instId,
    definitionId: defId,
    workflowRunId: wfId,
    status: "stopped",
  });
  const stepId = `step-${wfId}`;
  await db.insert(schema.agentStep).values({
    id: stepId,
    agentInstanceId: instId,
    workflowRunId: wfId,
    stepIndex: 0,
    phase: "act",
    actionType: "tool_call",
    actionJson: {} as never,
  });
  return { wfId, stepId };
}

async function insertTool(opts: {
  wfId: string;
  stepId: string;
  toolName: string;
  toolKind?: "builtin" | "mcp" | "skill" | "acp_connector";
  status?: "success" | "error" | "timeout" | "sandbox_blocked";
  request?: unknown;
  i: number;
}) {
  const db = await getDb();
  await db.insert(schema.toolCallLog).values({
    id: `tc-${opts.toolName}-${opts.i}-${opts.wfId}`,
    agentStepId: opts.stepId,
    workflowRunId: opts.wfId,
    toolName: opts.toolName,
    toolKind: opts.toolKind ?? "builtin",
    requestJson: (opts.request ?? {}) as never,
    status: opts.status ?? "success",
    latencyMs: 50,
  });
}

describe("B 类 · 工具调用质量", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "tq-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "tq-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "tq-sb", description: "" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("B-1 必备工具召回：research 调用 get_quote+news → 1（全召回）", async () => {
    const { wfId, stepId } = await setupWfWithStep();
    await insertTool({ wfId, stepId, toolName: "get_quote", toolKind: "mcp", i: 1 });
    await insertTool({ wfId, stepId, toolName: "news_search", toolKind: "mcp", i: 1 });
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, { workflowRunId: wfId, scenario: "research" });
    expect(r["B-1"]).toBe(1);
  });

  test("B-1 必备工具召回：research 只调 get_quote → 0.5", async () => {
    const { wfId, stepId } = await setupWfWithStep();
    await insertTool({ wfId, stepId, toolName: "get_quote", toolKind: "mcp", i: 1 });
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, { workflowRunId: wfId, scenario: "research" });
    expect(r["B-1"]).toBe(0.5);
  });

  test("B-1 必备工具召回：什么都没调 → 0", async () => {
    const { wfId } = await setupWfWithStep();
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, { workflowRunId: wfId, scenario: "research" });
    expect(r["B-1"]).toBe(0);
  });

  test("B-2 参数合理性：qty 为负的 order 调用应被识别为异常", async () => {
    const { wfId, stepId } = await setupWfWithStep();
    await insertTool({
      wfId,
      stepId,
      toolName: "order.create",
      i: 1,
      request: { qty: -10, symbol: "AAPL" },
    });
    await insertTool({
      wfId,
      stepId,
      toolName: "order.create",
      i: 2,
      request: { qty: 100, symbol: "AAPL" },
    });
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, {
      workflowRunId: wfId,
      scenario: "live_trading",
    });
    expect(r["B-2"]).toBeCloseTo(0.5, 5);
  });

  test("B-3 失败率：5 success / 5 error → 0.5", async () => {
    const { wfId, stepId } = await setupWfWithStep();
    for (let i = 0; i < 5; i++) {
      await insertTool({ wfId, stepId, toolName: "x.y", i, status: "success" });
    }
    for (let i = 5; i < 10; i++) {
      await insertTool({ wfId, stepId, toolName: "x.y", i, status: "error" });
    }
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, { workflowRunId: wfId, scenario: "research" });
    expect(r["B-3"]).toBeCloseTo(0.5, 5);
  });

  test("B-7 重复调用：同一 (toolName, request) 调用 5 次 → 红 (重复 tax = 5)", async () => {
    const { wfId, stepId } = await setupWfWithStep();
    for (let i = 0; i < 5; i++) {
      await insertTool({
        wfId,
        stepId,
        toolName: "fact.lookup",
        i,
        request: { ticker: "AAPL", date: "2026-06-01" },
      });
    }
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, { workflowRunId: wfId, scenario: "research" });
    expect(r["B-7"]).toBe(5);
  });

  test("B-7 没有重复 → 1", async () => {
    const { wfId, stepId } = await setupWfWithStep();
    await insertTool({ wfId, stepId, toolName: "a", i: 1, request: { x: 1 } });
    await insertTool({ wfId, stepId, toolName: "a", i: 2, request: { x: 2 } });
    await insertTool({ wfId, stepId, toolName: "b", i: 3, request: { x: 1 } });
    const sqlite = getSqliteForTesting();
    const r = await collectToolQuality(sqlite, { workflowRunId: wfId, scenario: "research" });
    expect(r["B-7"]).toBe(1);
  });
});
