/**
 * 回归测试：hardDeleteWorkflowRun 必须清掉所有持有 workflow_run_id FK 的衍生表。
 *
 * 背景 bug：migration 0049（监控 V2 P1）新增了 llm_call_log / skill_recall_log，
 * 但 hard-delete.ts 里 WORKFLOW_DIRECT_TABLES 没同步更新；硬删除 research 类
 * 工作流时，这些表的孤儿行让 `defer_foreign_keys = ON` 在 COMMIT 时报
 * "FOREIGN KEY constraint failed" → HTTP 500。
 *
 * Schema 收敛 C5-2（migration 0070）：原本还要覆盖 `connector_call_log` 的 FK
 * 清理路径，该表已删除，相应断言一并下线。
 *
 * 这里独立种入剩下两张表，验证 hardDeleteWorkflowRun 能干净清掉、且统计计数正确。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-hard-delete-fk-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const drizzle = await import("drizzle-orm");
const { hardDeleteWorkflowRun } = await import("../hard-delete");

const WORKSPACE_ID = "ws-hd-fk";
const PROJECT_ID = "proj-hd-fk";
const SANDBOX_ID = "sb-hd-fk";

describe("hardDeleteWorkflowRun: v2 monitoring 衍生表", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "hd-fk-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "hd-fk-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
    await db
      .insert(schema.sandboxPolicy)
      .values({ id: SANDBOX_ID, name: "hd-fk-sb", description: "" })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("覆盖 llm_call_log / skill_recall_log", async () => {
    const db = await getDb();
    const wfId = `wf-${crypto.randomUUID()}`;
    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      sessionId: null,
      goal: "hd-fk-research",
      mode: "research",
      source: "api",
      status: "completed",
    });

    // 1) llm_call_log：reason 节点每次 LLM 调用一行；workflow_run_id NOT NULL，无 CASCADE。
    await db.insert(schema.llmCallLog).values({
      id: `llm-${crypto.randomUUID()}`,
      workflowRunId: wfId,
      provider: "openai",
      model: "gpt-4",
      latencyMs: 123,
      status: "success",
    });

    // 2) skill_recall_log：需要先有 skill 行；这里只验 FK 链路能清，因此最少字段。
    const skillId = `skill-${crypto.randomUUID()}`;
    await db.insert(schema.agentSkill).values({
      id: skillId,
      projectId: PROJECT_ID,
      name: "hd-fk-skill",
    });
    await db.insert(schema.skillRecallLog).values({
      id: `sr-${crypto.randomUUID()}`,
      workflowRunId: wfId,
      skillId,
    });

    const result = await hardDeleteWorkflowRun(wfId);

    expect(result.details.workflow_run).toBe(1);
    expect(result.details.llm_call_log).toBe(1);
    expect(result.details.skill_recall_log).toBe(1);

    const gone = await db
      .select()
      .from(schema.workflowRun)
      .where(drizzle.eq(schema.workflowRun.id, wfId))
      .limit(1);
    expect(gone.length).toBe(0);

    const llmLeft = await db
      .select()
      .from(schema.llmCallLog)
      .where(drizzle.eq(schema.llmCallLog.workflowRunId, wfId));
    expect(llmLeft.length).toBe(0);
    const skillLeft = await db
      .select()
      .from(schema.skillRecallLog)
      .where(drizzle.eq(schema.skillRecallLog.workflowRunId, wfId));
    expect(skillLeft.length).toBe(0);
  });

  /**
   * 回归：清理 workflow 时如果还有 exec_call_log（NOT NULL FK，无 ON DELETE）
   * 或 agent_skill_run（SET NULL，但需要显式触发以保留审计统计）残留，
   * defer_foreign_keys=ON 在 COMMIT 时会报 FK violation。
   *
   * 这两张表是 2026-06 清理 360 条历史 workflow 时撞出来的：
   *   exec_call_log 在 0075 加入但 hard-delete 没同步覆盖。
   *   agent_skill_run 是 SET NULL，技术上不会阻塞，但要把 set_null 计数纳入审计。
   */
  test("覆盖 exec_call_log / agent_skill_run", async () => {
    const db = await getDb();
    const wfId = `wf-${crypto.randomUUID()}`;
    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      sessionId: null,
      goal: "hd-fk-exec",
      mode: "research",
      source: "api",
      status: "completed",
    });

    // 1) exec_call_log 需要 agent_step（NOT NULL FK），而 agent_step 依赖 agent_instance + agent_definition。
    const defId = `def-${crypto.randomUUID()}`;
    await db.insert(schema.agentDefinition).values({
      id: defId,
      role: "execution",
      name: "hd-fk-def",
      version: "v1",
      systemPrompt: "",
      toolsJson: [] as never,
      mcpServersJson: [] as never,
      skillsJson: [] as never,
      subscriptionsJson: [] as never,
      llmProvider: "mock",
      maxIterations: 1,
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
    await db.insert(schema.execCallLog).values({
      id: `exec-${crypto.randomUUID()}`,
      workflowRunId: wfId,
      agentStepId: stepId,
      providerId: "shell",
      execKind: "shell",
      binary: "ls",
      argsJson: "[]",
      cwd: "/tmp",
      status: "success",
    });

    // 2) agent_skill_run 是 SET NULL；需要把 set_null 计数纳入审计。
    const skillId = `skill-${crypto.randomUUID()}`;
    await db.insert(schema.agentSkill).values({
      id: skillId,
      projectId: PROJECT_ID,
      name: "hd-fk-skill-exec",
    });
    await db.insert(schema.agentSkillRun).values({
      id: `sr-${crypto.randomUUID()}`,
      skillId,
      workflowRunId: wfId,
      outcome: "success",
    });

    const result = await hardDeleteWorkflowRun(wfId);

    expect(result.details.workflow_run).toBe(1);
    expect(result.details.exec_call_log).toBe(1);
    // SET NULL：审计统计走 *_set_null 后缀，与 audit_log / scheduled_job_run 同构。
    expect(result.details.agent_skill_run_set_null).toBe(1);

    // exec_call_log 物理删除
    const execLeft = await db
      .select()
      .from(schema.execCallLog)
      .where(drizzle.eq(schema.execCallLog.workflowRunId, wfId));
    expect(execLeft.length).toBe(0);

    // agent_skill_run 行还在，但 workflow_run_id 已置空
    const skillRunRows = await db
      .select()
      .from(schema.agentSkillRun)
      .where(drizzle.eq(schema.agentSkillRun.skillId, skillId));
    expect(skillRunRows.length).toBe(1);
    expect(skillRunRows[0].workflowRunId).toBeNull();
  });

  /**
   * 三级 FK 链：fill ← broker_order ← order_intent ← workflow_run。
   *
   * 现有 hardDeleteWorkflowRun 只覆盖了二级链（broker_order via order_intent），
   * fill 表通过 broker_order_id NOT NULL 外键悬空，COMMIT 阶段 FK check 报错。
   *
   * 这是 2026-06 清理生产 360 条工作流时漏网的最后一条（wf_9331a385...）。
   */
  test("覆盖三级链 fill ← broker_order ← order_intent", async () => {
    const db = await getDb();
    const wfId = `wf-${crypto.randomUUID()}`;
    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      sessionId: null,
      goal: "hd-fk-fill",
      mode: "research",
      source: "api",
      status: "completed",
    });

    // strategy / instrument 链：只为了让 order_intent 的 NOT NULL FK 满足。
    const symbolId = `sym-${crypto.randomUUID()}`;
    await db.insert(schema.instrument).values({
      id: symbolId,
      symbol: "HD-FK-FILL",
      assetClass: "stock",
      exchange: "NASDAQ",
    });
    const stratId = `strat-${crypto.randomUUID()}`;
    await db.insert(schema.strategy).values({
      id: stratId,
      projectId: PROJECT_ID,
      name: "hd-fk-strat",
      style: "low_freq",
    });
    const stratVerId = `sv-${crypto.randomUUID()}`;
    await db.insert(schema.strategyVersion).values({
      id: stratVerId,
      strategyId: stratId,
      versionTag: "v1",
      logicHash: "deadbeef",
      paramSchemaJson: {} as never,
    });

    const oiId = `oi-${crypto.randomUUID()}`;
    await db.insert(schema.orderIntent).values({
      id: oiId,
      workflowRunId: wfId,
      strategyVersionId: stratVerId,
      instrumentId: symbolId,
      side: "buy",
      qty: 1,
      orderType: "market",
      timeInForce: "day",
    });
    const boId = `bo-${crypto.randomUUID()}`;
    await db.insert(schema.brokerOrder).values({
      id: boId,
      orderIntentId: oiId,
      accountId: "ta_builtin_paper",
      connectorInstanceId: "ci_builtin_paper_execution",
      brokerOrderId: "BX-1",
      status: "filled",
    });
    await db.insert(schema.fill).values({
      id: `fl-${crypto.randomUUID()}`,
      brokerOrderId: boId,
      fillQty: 1,
      fillPrice: 100,
    });

    const result = await hardDeleteWorkflowRun(wfId);
    expect(result.details.workflow_run).toBe(1);
    expect(result.details.fill).toBe(1);
    expect(result.details.broker_order).toBe(1);
    expect(result.details.order_intent).toBe(1);

    const fillsLeft = await db
      .select()
      .from(schema.fill)
      .where(drizzle.eq(schema.fill.brokerOrderId, boId));
    expect(fillsLeft.length).toBe(0);
  });
});
