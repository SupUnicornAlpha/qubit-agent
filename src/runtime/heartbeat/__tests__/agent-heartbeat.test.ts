/**
 * computeWorkflowHeartbeat 回归测试。
 *
 * 重点验证：
 *   - workflow 不存在 → kind="not_found"
 *   - 一个 instance + 多个 agent_step → 心跳取最近一条 step（lastPhase / lastStepIndex / lastStepAt）
 *   - silenceMs = nowMs - lastStepAt，且 endedAt 后变成 null
 *   - alive：status='running' && !endedAt
 *   - summary.totalSteps 累加全 workflow 的 agent_step 数
 *
 * 这个函数是 SSE bus + polling 路由共用的纯计算入口，跑偏会导致前端心跳全
 * panel 崩，所以这里要兜底。
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-hb-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const { computeWorkflowHeartbeat } = await import("../agent-heartbeat");

const WORKSPACE_ID = "ws-hb";
const PROJECT_ID = "proj-hb";
const SANDBOX_ID = "sb-hb";

async function seedBaseline(): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.workspace)
    .values({ id: WORKSPACE_ID, name: "hb-ws", owner: "test" })
    .onConflictDoNothing();
  await db
    .insert(schema.project)
    .values({
      id: PROJECT_ID,
      workspaceId: WORKSPACE_ID,
      name: "hb-proj",
      marketScope: "us",
    })
    .onConflictDoNothing();
  await db
    .insert(schema.sandboxPolicy)
    .values({ id: SANDBOX_ID, name: "hb-sb", description: "hb test sandbox" })
    .onConflictDoNothing();
}

describe("computeWorkflowHeartbeat", () => {
  beforeAll(async () => {
    await runMigrations();
    await seedBaseline();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("workflow 不存在返回 not_found", async () => {
    const r = await computeWorkflowHeartbeat("wf-does-not-exist");
    expect(r.kind).toBe("not_found");
  });

  test("活跃 instance + 多 step → 心跳取最近一条 step + alive=true + silenceMs 有值", async () => {
    const db = await getDb();
    const wfId = "wf-hb-running";
    const defId = "def-hb-running";
    const instId = "inst-hb-running";

    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      goal: "hb test running",
      mode: "research",
      status: "running",
    });
    await db.insert(schema.agentDefinition).values({
      id: defId,
      role: "analyst_fundamental",
      name: "hb-def-running",
      version: "v1",
      systemPrompt: "test",
      toolsJson: [],
      mcpServersJson: [],
      skillsJson: [],
      subscriptionsJson: ["TASK_ASSIGN"],
      llmProvider: "mock",
      maxIterations: 6,
      sandboxPolicyId: SANDBOX_ID,
      enabled: true,
    });
    await db.insert(schema.agentInstance).values({
      id: instId,
      workflowRunId: wfId,
      definitionId: defId,
      status: "running",
      currentIteration: 3,
      startedAt: "2026-05-27T00:00:00.000Z",
    });

    const earlier = "2026-05-27T00:00:10.000Z";
    const latest = "2026-05-27T00:00:30.000Z";
    await db.insert(schema.agentStep).values([
      {
        id: "step-1",
        workflowRunId: wfId,
        agentInstanceId: instId,
        stepIndex: 1,
        phase: "perceive",
        actionType: "tool_call",
        actionJson: {},
        createdAt: earlier,
      },
      {
        id: "step-2",
        workflowRunId: wfId,
        agentInstanceId: instId,
        stepIndex: 2,
        phase: "reason",
        actionType: "tool_call",
        actionJson: {},
        createdAt: latest,
      },
    ]);

    const r = await computeWorkflowHeartbeat(wfId);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;

    expect(r.snapshot.workflowRunId).toBe(wfId);
    expect(r.snapshot.status).toBe("running");
    expect(r.snapshot.heartbeats.length).toBe(1);
    const hb = r.snapshot.heartbeats[0];
    expect(hb).toBeTruthy();
    if (!hb) return;

    expect(hb.instanceId).toBe(instId);
    expect(hb.role).toBe("analyst_fundamental");
    expect(hb.currentIteration).toBe(3);
    /** lastPhase 应取最近的（reason）而不是更早的 perceive */
    expect(hb.lastPhase).toBe("reason");
    expect(hb.lastStepIndex).toBe(2);
    expect(hb.lastStepAt).toBe(latest);
    /** alive 由 status='running' 且 endedAt 为空决定 */
    expect(hb.alive).toBe(true);
    /** silenceMs 应有值（now - latest 一定是正数） */
    expect(hb.silenceMs).not.toBeNull();
    expect((hb.silenceMs ?? -1) >= 0).toBe(true);

    /** workflow 级别 summary */
    expect(r.snapshot.summary.aliveAgents).toBe(1);
    expect(r.snapshot.summary.totalAgents).toBe(1);
    expect(r.snapshot.summary.totalSteps).toBe(2);
    expect(r.snapshot.summary.lastStepAt).toBe(latest);
    expect(r.snapshot.summary.silenceMs).not.toBeNull();
  });

  test("已结束 instance（endedAt!=null）→ alive=false 且 silenceMs=null", async () => {
    const db = await getDb();
    const wfId = "wf-hb-ended";
    const defId = "def-hb-ended";
    const instId = "inst-hb-ended";

    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      goal: "hb test ended",
      mode: "research",
      status: "completed",
    });
    await db.insert(schema.agentDefinition).values({
      id: defId,
      role: "analyst_macro",
      name: "hb-def-ended",
      version: "v1",
      systemPrompt: "test",
      toolsJson: [],
      mcpServersJson: [],
      skillsJson: [],
      subscriptionsJson: ["TASK_ASSIGN"],
      llmProvider: "mock",
      maxIterations: 6,
      sandboxPolicyId: SANDBOX_ID,
      enabled: true,
    });
    await db.insert(schema.agentInstance).values({
      id: instId,
      workflowRunId: wfId,
      definitionId: defId,
      status: "stopped",
      currentIteration: 5,
      startedAt: "2026-05-27T00:00:00.000Z",
      endedAt: "2026-05-27T00:00:50.000Z",
    });

    const r = await computeWorkflowHeartbeat(wfId);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;

    const hb = r.snapshot.heartbeats[0];
    expect(hb).toBeTruthy();
    if (!hb) return;

    /** endedAt 非空 → alive=false 且 silenceMs=null（避免显示成 "卡 X 秒"） */
    expect(hb.alive).toBe(false);
    expect(hb.silenceMs).toBeNull();
    expect(hb.endedAt).toBe("2026-05-27T00:00:50.000Z");

    /** summary.aliveAgents 不应把已结束的计入 */
    expect(r.snapshot.summary.aliveAgents).toBe(0);
    expect(r.snapshot.summary.totalAgents).toBe(1);
  });

  test("没有 step 的 instance：lastStepAt 退化到 startedAt", async () => {
    const db = await getDb();
    const wfId = "wf-hb-nostep";
    const defId = "def-hb-nostep";
    const instId = "inst-hb-nostep";

    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      goal: "hb test no-step",
      mode: "research",
      status: "running",
    });
    await db.insert(schema.agentDefinition).values({
      id: defId,
      role: "analyst_technical",
      name: "hb-def-nostep",
      version: "v1",
      systemPrompt: "test",
      toolsJson: [],
      mcpServersJson: [],
      skillsJson: [],
      subscriptionsJson: ["TASK_ASSIGN"],
      llmProvider: "mock",
      maxIterations: 6,
      sandboxPolicyId: SANDBOX_ID,
      enabled: true,
    });
    await db.insert(schema.agentInstance).values({
      id: instId,
      workflowRunId: wfId,
      definitionId: defId,
      status: "running",
      currentIteration: 0,
      startedAt: "2026-05-27T00:00:00.000Z",
    });

    const r = await computeWorkflowHeartbeat(wfId);
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;

    const hb = r.snapshot.heartbeats[0];
    expect(hb).toBeTruthy();
    if (!hb) return;

    expect(hb.lastPhase).toBeNull();
    expect(hb.lastStepIndex).toBeNull();
    /** lastStepAt 没 step 时退化到 startedAt（让前端能算 silenceMs，不至于完全空） */
    expect(hb.lastStepAt).toBe("2026-05-27T00:00:00.000Z");
    expect(hb.silenceMs).not.toBeNull();
    expect(hb.alive).toBe(true);
  });
});
