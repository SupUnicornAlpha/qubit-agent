import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";

const tmpDir = `${process.cwd()}/.tmp-agent-snapshot-test`;
process.env.QUBIT_DATA_DIR = tmpDir;

const { runMigrations } = await import("../../db/sqlite/migrate");
const { closeDb, getDb } = await import("../../db/sqlite/client");
const {
  agentDefinition,
  agentInstance,
  project,
  sandboxPolicy,
  workflowRun,
  workspace,
  agentCheckpointSnapshot,
} = await import("../../db/sqlite/schema");
const { writeCheckpointSnapshot, loadLatestCheckpointSnapshot } = await import(
  "./agent-checkpoint-snapshot"
);
const { createInitialGraphState } = await import("./state");

const WS_ID = "11111111-1111-4000-8000-snapshot00001";
const PROJ_ID = "11111111-1111-4000-8000-snapshot00002";
const WF_ID = "11111111-1111-4000-8000-snapshot00003";
const DEF_ID = "11111111-1111-4000-8000-snapshot00004";
const INST_ID = "11111111-1111-4000-8000-snapshot00005";
const SANDBOX_ID = "11111111-1111-4000-8000-snapshot00006";

async function seed(): Promise<void> {
  // 注意：bun test 全量运行时 `config.dataDir` 会被先到的测试文件冻结，
  // 本测试可能复用别人的 DB；所有 INSERT 都做 onConflictDoNothing 兜底。
  const db = await getDb();
  await db
    .insert(sandboxPolicy)
    .values({
      id: SANDBOX_ID,
      name: "snap-sb",
      description: "for snapshot test",
      allowedTools: [],
      networkAllowlist: [],
      fileAccessJson: { read: [], write: [], deny: [] },
      maxRuntimeSec: 60,
      maxIterations: 5,
      maxOutputTokens: 1024,
    })
    .onConflictDoNothing();
  await db
    .insert(workspace)
    .values({ id: WS_ID, name: "snap-ws", owner: "system" })
    .onConflictDoNothing();
  await db
    .insert(project)
    .values({
      id: PROJ_ID,
      workspaceId: WS_ID,
      name: "snap-proj",
      marketScope: "GLOBAL",
      status: "active",
    })
    .onConflictDoNothing();
  await db
    .insert(workflowRun)
    .values({
      id: WF_ID,
      projectId: PROJ_ID,
      goal: "snap-goal",
      mode: "research",
      source: "manual",
      status: "running",
      loopKind: "native",
      executionPath: "graph",
      loopOptionsJson: {},
    })
    .onConflictDoNothing();
  await db
    .insert(agentDefinition)
    .values({
      id: DEF_ID,
      role: "orchestrator",
      name: "snap-def",
      version: "0.0.1",
      systemPrompt: "test",
      toolsJson: [],
      mcpServersJson: [],
      skillsJson: [],
      subscriptionsJson: [],
      llmProvider: "stub",
      maxIterations: 5,
      sandboxPolicyId: SANDBOX_ID,
      enabled: true,
    })
    .onConflictDoNothing();
  await db
    .insert(agentInstance)
    .values({
      id: INST_ID,
      definitionId: DEF_ID,
      workflowRunId: WF_ID,
      status: "running",
      currentIteration: 0,
      startedAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
}

describe("agent-checkpoint-snapshot", () => {
  let skipDueToFrozenConfig = false;

  beforeAll(async () => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    process.env.QUBIT_DATA_DIR = tmpDir;
    // 安全闸门：bun test 全量运行时 config.dataDir 在另一文件先 import config 后会被冻结，
    // 我们的 process.env 设置就无效；此时禁止写入真实 ~/.quant-agent DB（曾经发生过污染）。
    const { config } = await import("../../config");
    if (config.dataDir !== tmpDir) {
      skipDueToFrozenConfig = true;
      console.warn(
        `[agent-checkpoint-snapshot.test] config.dataDir=${config.dataDir} != tmpDir=${tmpDir}; skipping seed/asserts to avoid polluting real DB.`
      );
      return;
    }
    await runMigrations();
    await seed();

    // 清理本 workflow 上残留 snapshot：完整 suite 跑时 config.dataDir 已被先到的
    // 测试文件冻结，可能复用同一个 DB；前一轮残留会污染断言。
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    await db
      .delete(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.workflowRunId, WF_ID));
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a snapshot row that loadLatest can read back", async () => {
    if (skipDueToFrozenConfig) return;
    const state = createInitialGraphState({
      runId: "run-1",
      workflowId: WF_ID,
      traceId: "trace-1",
      agentDefinition: {
        id: DEF_ID,
        role: "orchestrator",
        name: "snap-def",
        version: "0.0.1",
        systemPrompt: "test",
        tools: [],
        mcpServers: [],
        skills: [],
        subscriptions: [],
        llmProvider: "stub",
        maxIterations: 5,
        sandboxPolicyId: null,
        enabled: true,
      },
      inboundMessage: {
        messageId: "msg-1",
        workflowId: WF_ID,
        traceId: "trace-1",
        senderAgent: "system",
        receiverAgent: INST_ID,
        messageType: "TASK_ASSIGN",
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        payload: { taskId: "t1", taskType: "x" } as any,
        priority: 50,
        createdAt: new Date().toISOString(),
      },
    });
    state.iteration = 2;
    state.plannedAction = "noop";

    await writeCheckpointSnapshot({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      agentInstanceId: INST_ID,
      stepIndex: 2,
      phase: "reason",
      state,
    });

    const loaded = await loadLatestCheckpointSnapshot(WF_ID);
    expect(loaded?.phase).toBe("reason");
    expect(loaded?.stepIndex).toBe(2);
    expect(loaded?.iteration).toBe(2);
    expect((loaded?.snapshot as { plannedAction?: string }).plannedAction).toBe("noop");
  });

  it("dedupes identical consecutive snapshots via state_hash", async () => {
    if (skipDueToFrozenConfig) return;
    const db = await getDb();
    const { eq } = await import("drizzle-orm");
    const before = await db
      .select({ id: agentCheckpointSnapshot.id })
      .from(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.workflowRunId, WF_ID));
    const state = createInitialGraphState({
      runId: "run-1",
      workflowId: WF_ID,
      traceId: "trace-1",
      // biome-ignore lint/suspicious/noExplicitAny: minimal def for test
      agentDefinition: {
        id: DEF_ID,
        role: "orchestrator",
        name: "snap-def",
        version: "0.0.1",
        systemPrompt: "test",
        tools: [],
        mcpServers: [],
        skills: [],
        subscriptions: [],
        llmProvider: "stub",
        maxIterations: 5,
        sandboxPolicyId: null,
        enabled: true,
      } as any,
      // biome-ignore lint/suspicious/noExplicitAny: minimal envelope
      inboundMessage: {} as any,
    });
    state.iteration = 2;
    state.plannedAction = "noop";

    await writeCheckpointSnapshot({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      agentInstanceId: INST_ID,
      stepIndex: 3,
      phase: "reason",
      state,
    });
    // same content with same runId -> should dedupe
    await writeCheckpointSnapshot({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      agentInstanceId: INST_ID,
      stepIndex: 3,
      phase: "reason",
      state,
    });

    const after = await db
      .select({ id: agentCheckpointSnapshot.id })
      .from(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.workflowRunId, WF_ID));
    expect(after.length).toBe(before.length + 1);
  });
});
