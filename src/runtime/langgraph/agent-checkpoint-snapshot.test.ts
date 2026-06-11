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
const {
  writeCheckpointSnapshot,
  loadLatestCheckpointSnapshot,
  loadLatestSnapshotByRunId,
  restoreStateFromSnapshot,
  deleteCheckpointSnapshotsForWorkflow,
} = await import("./agent-checkpoint-snapshot");
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
        sandboxPolicyId: SANDBOX_ID,
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

  it("loadLatestSnapshotByRunId isolates snapshots by runId (MSA fan-out)", async () => {
    if (skipDueToFrozenConfig) return;
    // 两个并发 slot 共享 workflowRunId 但各有独立 runId
    const mkState = (runId: string, planned: string) => {
      const s = createInitialGraphState({
        runId,
        workflowId: WF_ID,
        traceId: "trace-msa",
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
      s.iteration = 1;
      s.plannedAction = planned;
      return s;
    };
    await writeCheckpointSnapshot({
      runId: "msa-slot-a",
      workflowId: WF_ID,
      traceId: "trace-msa",
      agentInstanceId: INST_ID,
      stepIndex: 1,
      phase: "act",
      state: mkState("msa-slot-a", "slot-a-action"),
    });
    await writeCheckpointSnapshot({
      runId: "msa-slot-b",
      workflowId: WF_ID,
      traceId: "trace-msa",
      agentInstanceId: INST_ID,
      stepIndex: 1,
      phase: "act",
      state: mkState("msa-slot-b", "slot-b-action"),
    });

    const a = await loadLatestSnapshotByRunId("msa-slot-a");
    const b = await loadLatestSnapshotByRunId("msa-slot-b");
    expect((a?.snapshot as { plannedAction?: string }).plannedAction).toBe("slot-a-action");
    expect((b?.snapshot as { plannedAction?: string }).plannedAction).toBe("slot-b-action");
  });

  it("end-to-end: write → loadByRunId → restore yields resumable state with full def", async () => {
    if (skipDueToFrozenConfig) return;
    // 快照里只会保存裁剪后的 def；resume 时必须用完整 def 覆盖
    const fullDef = {
      id: DEF_ID,
      role: "orchestrator" as const,
      name: "snap-def",
      version: "0.0.1",
      systemPrompt: "FULL system prompt only in DB",
      tools: ["tool_x", "tool_y"],
      mcpServers: ["mcp_z"],
      skills: ["skill_q"],
      subscriptions: ["TASK_ASSIGN" as const],
      llmProvider: "stub",
      maxIterations: 5,
      sandboxPolicyId: SANDBOX_ID,
      enabled: true,
    };
    const state = createInitialGraphState({
      runId: "e2e-run",
      workflowId: WF_ID,
      traceId: "trace-e2e",
      agentDefinition: fullDef,
      inboundMessage: {
        messageId: "msg-e2e",
        workflowId: WF_ID,
        traceId: "trace-e2e",
        senderAgent: "system",
        receiverAgent: INST_ID,
        messageType: "TASK_ASSIGN",
        // biome-ignore lint/suspicious/noExplicitAny: test fixture
        payload: { taskId: "te2e", taskType: "research" } as any,
        priority: 50,
        createdAt: new Date().toISOString(),
      },
    });
    state.iteration = 4;
    state.reasonText = "thinking";
    state.toolCalls = [{ tool: "tool_x", ok: true }];
    state.observations = [{ r: "obs1" }, { r: "obs2" }];
    state.contextMemory = { ticker: "MSFT" };

    await writeCheckpointSnapshot({
      runId: "e2e-run",
      workflowId: WF_ID,
      traceId: "trace-e2e",
      agentInstanceId: INST_ID,
      stepIndex: 4,
      phase: "observe",
      state,
    });

    const loaded = await loadLatestSnapshotByRunId("e2e-run");
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    const { state: restored, resumeIteration, resumePhase } = restoreStateFromSnapshot(
      loaded,
      fullDef
    );
    // 决策字段全量还原
    expect(resumeIteration).toBe(4);
    expect(resumePhase).toBe("observe");
    expect(restored.reasonText).toBe("thinking");
    expect(restored.toolCalls).toEqual([{ tool: "tool_x", ok: true }]);
    expect(restored.observations).toEqual([{ r: "obs1" }, { r: "obs2" }]);
    expect(restored.contextMemory).toEqual({ ticker: "MSFT" });
    // 完整 def 来自传入参数，而非快照里被裁剪的版本
    expect(restored.agentDefinition.tools).toEqual(["tool_x", "tool_y"]);
    expect(restored.agentDefinition.systemPrompt).toBe("FULL system prompt only in DB");
    // inboundMessage 从快照恢复
    expect(restored.inboundMessage.messageId).toBe("msg-e2e");
  });

  it("restoreStateFromSnapshot honors inboundMessage override", async () => {
    if (skipDueToFrozenConfig) return;
    const loaded = await loadLatestSnapshotByRunId("e2e-run");
    if (!loaded) return;
    const fullDef = {
      id: DEF_ID,
      role: "orchestrator" as const,
      name: "snap-def",
      version: "0.0.1",
      systemPrompt: "x",
      tools: [],
      mcpServers: [],
      skills: [],
      subscriptions: ["TASK_ASSIGN" as const],
      llmProvider: "stub",
      maxIterations: 5,
      sandboxPolicyId: SANDBOX_ID,
      enabled: true,
    };
    const override = {
      messageId: "msg-override",
      workflowId: WF_ID,
      traceId: "trace-e2e",
      senderAgent: "system",
      receiverAgent: INST_ID,
      messageType: "TASK_ASSIGN" as const,
      // biome-ignore lint/suspicious/noExplicitAny: test fixture
      payload: { taskId: "ovr", taskType: "research" } as any,
      priority: 50,
      createdAt: new Date().toISOString(),
    };
    // biome-ignore lint/suspicious/noExplicitAny: envelope override
    const { state } = restoreStateFromSnapshot(loaded, fullDef, override as any);
    expect(state.inboundMessage.messageId).toBe("msg-override");
  });

  it("deleteCheckpointSnapshotsForWorkflow clears all rows for new-turn (resume sees nothing)", async () => {
    if (skipDueToFrozenConfig) return;
    // 先确认 WF_ID 上有快照（前面几个用例已写入）
    const before = await loadLatestCheckpointSnapshot(WF_ID);
    expect(before).not.toBeNull();

    const deleted = await deleteCheckpointSnapshotsForWorkflow(WF_ID);
    expect(deleted).toBeGreaterThan(0);

    // 清空后 resume 权威（按 workflow 取最近）应当落空 → fail-soft 回退 fresh
    const after = await loadLatestCheckpointSnapshot(WF_ID);
    expect(after).toBeNull();
  });
});
