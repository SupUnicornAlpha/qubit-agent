/**
 * snapshot-collector 集成测试：把 fixture 行写进 tmpdir SQLite，
 * 然后调 collector，断言它能算出 6 个 must-have 指标。
 *
 * 这里测的是 SQL 抓取逻辑，不接触真 LLM。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(
  tmpdir(),
  `qubit-readiness-collector-${process.pid}-${Date.now()}`
);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const { collectSnapshot } = await import("../snapshot-collector");

const WORKSPACE_ID = "ws-readiness-collector";
const PROJECT_ID = "proj-readiness-collector";
const SANDBOX_ID = "sb-readiness-collector";

async function setupWorkflow(opts: {
  status: "completed" | "failed" | "running" | "cancelled" | "timeout";
  /** 用作 workflow_run.created_at（也就是 collector 算 M-1 时间窗口的下界） */
  createdAt?: string;
  endedAt?: string | null;
}): Promise<string> {
  const db = await getDb();
  const wfId = `wf-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id: wfId,
    projectId: PROJECT_ID,
    sessionId: null,
    goal: "readiness collector test",
    mode: "research",
    source: "api",
    status: opts.status,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.endedAt !== undefined ? { endedAt: opts.endedAt } : {}),
  });
  return wfId;
}

async function setupAgentInstance(wfId: string): Promise<{
  defId: string;
  instId: string;
  stepId: string;
}> {
  const db = await getDb();
  const defId = `def-${crypto.randomUUID()}`;
  await db.insert(schema.agentDefinition).values({
    id: defId,
    role: "orchestrator",
    name: "rc-def",
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
  const instId = `inst-${crypto.randomUUID()}`;
  await db.insert(schema.agentInstance).values({
    id: instId,
    definitionId: defId,
    workflowRunId: wfId,
    status: "stopped",
  });
  const stepId = `step-${crypto.randomUUID()}`;
  await db.insert(schema.agentStep).values({
    id: stepId,
    agentInstanceId: instId,
    workflowRunId: wfId,
    stepIndex: 0,
    phase: "act",
    actionType: "tool_call",
    actionJson: {} as never,
  });
  return { defId, instId, stepId };
}

describe("collectSnapshot", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "rc-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "rc-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "rc-sb", description: "" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("空工作流：所有指标默认 0 / null（M-1 红，T-6 = 0 绿）", async () => {
    const wfId = await setupWorkflow({ status: "completed" });
    const snapshot = await collectSnapshot({
      workflowRunId: wfId,
      scenario: "research",
    });

    expect(snapshot.workflowRunId).toBe(wfId);
    expect(snapshot.scenario).toBe("research");
    expect(snapshot.workflowStatus).toBe("completed");

    // O-1：完成态计为 1
    expect(snapshot.metrics["O-1"]).toBe(1);
    // T-1：无 tool 调用 → 0 失败率（绿）
    expect(snapshot.metrics["T-1"]).toBe(0);
    // T-3：无 MCP 调用 → 0 open 率
    expect(snapshot.metrics["T-3"]).toBe(0);
    // T-6：0 token
    expect(snapshot.metrics["T-6"]).toBe(0);
    // S-1：无 skill 召回 → null（无法判定）
    expect(snapshot.metrics["S-1"]).toBeNull();
    // M-1：无 longterm_memory 写入 → 0
    expect(snapshot.metrics["M-1"]).toBe(0);
  });

  test("有 tool_call_log：T-1 按比例算（5 success / 5 error → 0.5）", async () => {
    const wfId = await setupWorkflow({ status: "completed" });
    const { stepId } = await setupAgentInstance(wfId);
    const db = await getDb();
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.toolCallLog).values({
        id: `tc-ok-${i}-${wfId}`,
        agentStepId: stepId,
        workflowRunId: wfId,
        toolName: "screener.run",
        toolKind: "builtin",
        requestJson: {} as never,
        status: "success",
        latencyMs: 100,
      });
    }
    for (let i = 0; i < 5; i++) {
      await db.insert(schema.toolCallLog).values({
        id: `tc-err-${i}-${wfId}`,
        agentStepId: stepId,
        workflowRunId: wfId,
        toolName: "screener.run",
        toolKind: "builtin",
        requestJson: {} as never,
        status: "error",
        latencyMs: 100,
      });
    }

    const snapshot = await collectSnapshot({
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(snapshot.metrics["T-1"]).toBe(0.5);
  });

  test("有 mcp_call_log：T-3 = open / 总数；circuit_state=null 不计入分母", async () => {
    const wfId = await setupWorkflow({ status: "completed" });
    const { stepId } = await setupAgentInstance(wfId);
    const db = await getDb();
    // 4 条 mcp，2 条 closed，1 条 open，1 条 null
    await db.insert(schema.mcpCallLog).values([
      {
        id: `mc-1-${wfId}`,
        workflowRunId: wfId,
        agentStepId: stepId,
        serverName: "fs",
        toolName: "read",
        requestJson: {} as never,
        status: "success",
        circuitState: "closed",
      },
      {
        id: `mc-2-${wfId}`,
        workflowRunId: wfId,
        agentStepId: stepId,
        serverName: "fs",
        toolName: "read",
        requestJson: {} as never,
        status: "success",
        circuitState: "closed",
      },
      {
        id: `mc-3-${wfId}`,
        workflowRunId: wfId,
        agentStepId: stepId,
        serverName: "fs",
        toolName: "read",
        requestJson: {} as never,
        status: "failed",
        circuitState: "open",
      },
      {
        id: `mc-4-${wfId}`,
        workflowRunId: wfId,
        agentStepId: stepId,
        serverName: "fs",
        toolName: "read",
        requestJson: {} as never,
        status: "success",
        circuitState: null,
      },
    ]);

    const snapshot = await collectSnapshot({
      workflowRunId: wfId,
      scenario: "research",
    });
    // 1 open / 3 非 null = 0.333
    expect(snapshot.metrics["T-3"]).toBeCloseTo(1 / 3, 5);
  });

  test("有 llm_call_log：T-6 = 总 total_tokens", async () => {
    const wfId = await setupWorkflow({ status: "completed" });
    const db = await getDb();
    await db.insert(schema.llmCallLog).values([
      {
        id: `llm-1-${wfId}`,
        workflowRunId: wfId,
        provider: "openai",
        model: "gpt-4",
        latencyMs: 100,
        status: "success",
        totalTokens: 1000,
      },
      {
        id: `llm-2-${wfId}`,
        workflowRunId: wfId,
        provider: "openai",
        model: "gpt-4",
        latencyMs: 100,
        status: "success",
        totalTokens: 500,
      },
    ]);

    const snapshot = await collectSnapshot({
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(snapshot.metrics["T-6"]).toBe(1500);
  });

  test("有 skill_recall_log：S-1 = executed=1 占比", async () => {
    const wfId = await setupWorkflow({ status: "completed" });
    const db = await getDb();
    const skillId = `skill-rc-${crypto.randomUUID()}`;
    await db.insert(schema.agentSkill).values({
      id: skillId,
      projectId: PROJECT_ID,
      name: `rc-skill-${skillId}`,
    });
    await db.insert(schema.skillRecallLog).values([
      { id: `rec-1-${wfId}`, workflowRunId: wfId, skillId, executed: true },
      { id: `rec-2-${wfId}`, workflowRunId: wfId, skillId, executed: false },
      { id: `rec-3-${wfId}`, workflowRunId: wfId, skillId, executed: false },
      { id: `rec-4-${wfId}`, workflowRunId: wfId, skillId, executed: true },
    ]);

    const snapshot = await collectSnapshot({
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(snapshot.metrics["S-1"]).toBe(0.5);
  });

  test("M-1：在工作流时间窗口内有 longterm_memory 写入 → ≥ 1", async () => {
    // longterm_memory.updated_at 由 SQL default 走 strftime('now')，drizzle 写入路径会覆盖手动值；
    // 因此把 workflow 时间窗口设成"包含现在"，让 default updatedAt 落在窗口内即可。
    const createdAt = new Date(Date.now() - 60_000).toISOString();
    const endedAt = new Date(Date.now() + 60_000).toISOString();
    const wfId = await setupWorkflow({
      status: "completed",
      createdAt,
      endedAt,
    });
    const db = await getDb();
    await db.insert(schema.longtermMemory).values({
      id: `lm-in-${wfId}`,
      scope: "project",
      scopeId: PROJECT_ID,
      memoryType: "playbook",
      contentJson: { note: "hit" } as never,
      validFrom: createdAt,
      asofTime: createdAt,
    });

    const snapshot = await collectSnapshot({
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(snapshot.metrics["M-1"]).toBeGreaterThanOrEqual(1);
  });
});
