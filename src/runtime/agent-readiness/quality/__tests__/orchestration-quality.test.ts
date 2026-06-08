/**
 * D 类 · 编排质量（D-2 步数效率 / D-3 phase 时间占比）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-aqm-orch-${process.pid}-${Date.now()}`);
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
const { collectOrchestrationQuality } = await import("../orchestration-quality");

const WORKSPACE_ID = "ws-aqm-orch";
const PROJECT_ID = "proj-aqm-orch";
const SANDBOX_ID = "sb-aqm-orch";

async function setupWf(): Promise<{ wfId: string; instId: string; defId: string }> {
  const db = await getDb();
  const wfId = `wf-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id: wfId,
    projectId: PROJECT_ID,
    sessionId: null,
    goal: "orch",
    mode: "research",
    source: "api",
    status: "completed",
  });
  const defId = `def-${wfId}`;
  await db.insert(schema.agentDefinition).values({
    id: defId,
    role: "orchestrator",
    name: "od-def",
    version: "v1",
    systemPrompt: "",
    toolsJson: [] as never,
    mcpServersJson: [] as never,
    skillsJson: [] as never,
    subscriptionsJson: [] as never,
    llmProvider: "mock",
    maxIterations: 10,
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
  return { wfId, instId, defId };
}

async function insertStep(opts: {
  instId: string;
  wfId: string;
  index: number;
  phase: "perceive" | "reason" | "act" | "observe" | "external";
  latencyMs: number;
}) {
  const db = await getDb();
  await db.insert(schema.agentStep).values({
    id: `s-${opts.index}-${opts.wfId}`,
    agentInstanceId: opts.instId,
    workflowRunId: opts.wfId,
    stepIndex: opts.index,
    phase: opts.phase,
    actionType: "tool_call",
    actionJson: {} as never,
    latencyMs: opts.latencyMs,
  } as never);
}

describe("D 类 · 编排质量", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "od-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "od-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "od-sb", description: "" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("D-2 步数效率：max_iterations=10 用了 5 步 → 0.5", async () => {
    const { wfId, instId } = await setupWf();
    for (let i = 0; i < 5; i++) {
      await insertStep({ wfId, instId, index: i, phase: "act", latencyMs: 100 });
    }
    const sqlite = getSqliteForTesting();
    const r = await collectOrchestrationQuality(sqlite, wfId);
    expect(r["D-2"]).toBeCloseTo(0.5, 5);
  });

  test("D-2 步数效率：用满 10 步 → 1（触顶）", async () => {
    const { wfId, instId } = await setupWf();
    for (let i = 0; i < 10; i++) {
      await insertStep({ wfId, instId, index: i, phase: "act", latencyMs: 50 });
    }
    const sqlite = getSqliteForTesting();
    const r = await collectOrchestrationQuality(sqlite, wfId);
    expect(r["D-2"]).toBe(1);
  });

  test("D-3 phase 时间占比：reason 600 + act 300 + observe 100 → reason+act = 0.9", async () => {
    const { wfId, instId } = await setupWf();
    await insertStep({ wfId, instId, index: 0, phase: "reason", latencyMs: 600 });
    await insertStep({ wfId, instId, index: 1, phase: "act", latencyMs: 300 });
    await insertStep({ wfId, instId, index: 2, phase: "observe", latencyMs: 100 });
    const sqlite = getSqliteForTesting();
    const r = await collectOrchestrationQuality(sqlite, wfId);
    expect(r["D-3"]).toBeCloseTo(0.9, 5);
  });

  test("空 workflow → D-2=null, D-3=null", async () => {
    const { wfId } = await setupWf();
    const sqlite = getSqliteForTesting();
    const r = await collectOrchestrationQuality(sqlite, wfId);
    expect(r["D-2"]).toBeNull();
    expect(r["D-3"]).toBeNull();
  });
});
