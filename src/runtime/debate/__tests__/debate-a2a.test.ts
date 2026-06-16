/**
 * 辩论 A2A 传输层测试。
 *
 * 覆盖 debate-a2a.ts 里真正新增、有风险的逻辑：
 *   1. ensureDebateAgentDefs：幂等插入 bull/bear def(enabled=false)，作为 instance 的 FK 锚点；
 *   2. setupDebateA2A：为本 workflow 建 bull/bear 专属实例 + 起 runtime，cleanup 后标 stopped。
 *
 * 单回合发言的总线往返(派单→handler→回包)复用 a2a-gather / AgentRuntime / a2aRouter，
 * 已在 a2a-gather.test.ts 与 team-slot-a2a.test.ts 锁定，这里不再依赖 LLM mock 重复断言。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-debate-a2a-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const { eq } = await import("drizzle-orm");
const { ensureDebateAgentDefs, setupDebateA2A } = await import("../debate-a2a");

const WORKSPACE_ID = "ws-debate-a2a";
const PROJECT_ID = "proj-debate-a2a";
const WORKFLOW_ID = "wf-debate-a2a";
const ORCH_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("debate A2A transport", () => {
  beforeAll(async () => {
    closeDb();
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: "sp-debate", name: "debate-test" })
      .onConflictDoNothing();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "t", owner: "t" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: "p", marketScope: "us" })
      .onConflictDoNothing();
    await db
      .insert(schema.workflowRun)
      .values({
        id: WORKFLOW_ID,
        projectId: PROJECT_ID,
        goal: "t",
        mode: "research",
        source: "api",
        status: "running",
      })
      .onConflictDoNothing();
    // 模板 enabled def —— ensureDebateAgentDefs 从中取 sandbox_policy / llm_provider。
    await db
      .insert(schema.agentDefinition)
      .values({
        id: "def-tmpl-research",
        role: "research",
        name: "tmpl",
        systemPrompt: "x",
        llmProvider: "mock",
        sandboxPolicyId: "sp-debate",
        enabled: true,
      })
      .onConflictDoNothing();
    // orchestrator 实例（派单 sender，需是可解析的 agent_instance 才会落 a2a_message）。
    await db
      .insert(schema.agentInstance)
      .values({
        id: ORCH_INSTANCE_ID,
        definitionId: "def-tmpl-research",
        workflowRunId: WORKFLOW_ID,
        status: "running",
        currentIteration: 0,
        startedAt: new Date().toISOString(),
      })
      .onConflictDoNothing();
  });

  afterAll(() => {
    closeDb();
  });

  test("ensureDebateAgentDefs 幂等插入 bull/bear def(enabled=false)", async () => {
    const db = await getDb();
    await ensureDebateAgentDefs(db);
    await ensureDebateAgentDefs(db); // 第二次不应抛错 / 不应重复插入

    const defs = await db
      .select({
        id: schema.agentDefinition.id,
        role: schema.agentDefinition.role,
        enabled: schema.agentDefinition.enabled,
      })
      .from(schema.agentDefinition)
      .where(eq(schema.agentDefinition.role, "researcher_bull"));
    expect(defs).toHaveLength(1);
    expect(defs[0]?.id).toBe("def-researcher-bull");
    expect(defs[0]?.enabled).toBe(false);

    const bear = await db
      .select({ id: schema.agentDefinition.id })
      .from(schema.agentDefinition)
      .where(eq(schema.agentDefinition.id, "def-researcher-bear"));
    expect(bear).toHaveLength(1);
  });

  test("setupDebateA2A 建 bull/bear 专属实例，cleanup 后标 stopped", async () => {
    const db = await getDb();
    const setup = await setupDebateA2A({
      workflowRunId: WORKFLOW_ID,
      traceId: "tr-debate",
      orchestratorInstanceId: ORCH_INSTANCE_ID,
      timeoutMs: 5000,
    });
    expect(typeof setup.runTurn).toBe("function");

    const bullDefInstances = await db
      .select({ id: schema.agentInstance.id, status: schema.agentInstance.status })
      .from(schema.agentInstance)
      .where(eq(schema.agentInstance.definitionId, "def-researcher-bull"));
    expect(bullDefInstances).toHaveLength(1);
    expect(bullDefInstances[0]?.status).toBe("running");

    await setup.cleanup();

    const afterCleanup = await db
      .select({ status: schema.agentInstance.status })
      .from(schema.agentInstance)
      .where(eq(schema.agentInstance.definitionId, "def-researcher-bull"));
    expect(afterCleanup[0]?.status).toBe("stopped");
  });
});
