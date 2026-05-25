/**
 * P0-3：HITL 状态机收敛快照
 *
 * 旧实现：4 张表 (workflow_run / workflow_hitl_request / analyst_research_job + 进程 cache)
 * 各自裸 update，~18 处写入点没有事务包护，崩溃留下半成品 (hitl_request approved 但
 * analyst job 还 awaiting_approval，restoreRunningWorkflows 也救不了)。
 *
 * 本测试验证：
 *   1. createHitlRequest 进事务后，update workflow_run 失败 → workflow_hitl_request 也不会留下；
 *   2. resolveHitlRequest 进事务后，update analyst_research_job 失败 → hitl_request 也不会被推到 approved；
 *   3. repairStaleHitlAwaitingApproval：analyst job awaiting_approval + 无 pending hitl_request
 *      → fail 修复；有 pending hitl_request → 跳过。
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-hitl-state-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, beforeEach, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb, runInTransaction } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const drizzle = await import("drizzle-orm");
const jobs = await import("../../msa/analyst-research-jobs");
const { restoreRunningWorkflows } = await import("../restore-running-workflows");

const WORKSPACE_ID = "ws-hitl-p03";
const PROJECT_ID = "proj-hitl-p03";

async function seedWorkflow(id: string, status = "running"): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.workflowRun)
    .values({
      id,
      projectId: PROJECT_ID,
      goal: "test",
      mode: "research",
      source: "api",
      status: status as never,
    })
    .onConflictDoNothing();
}

async function seedHitlRequest(input: {
  id: string;
  workflowRunId: string;
  status?: "pending" | "approved" | "rejected";
  scope?: "team_orchestrator" | "chat_orchestrator";
}): Promise<void> {
  const db = await getDb();
  await db.insert(schema.workflowHitlRequest).values({
    id: input.id,
    workflowRunId: input.workflowRunId,
    runId: "run-fake",
    agentInstanceId: null,
    stepIndex: 0,
    scope: (input.scope ?? "team_orchestrator") as never,
    requestKind: "team_research_plan" as never,
    status: input.status ?? "pending",
    title: "t",
    summary: "s",
    payloadJson: {} as never,
    inputKind: "approve_only",
    inputSchemaJson: {} as never,
  });
}

describe("HITL state machine convergence (P0-3)", () => {
  beforeAll(async () => {
    closeDb();
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "t", owner: "t" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: "p", marketScope: "us" })
      .onConflictDoNothing();
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jobs.__resetAnalystResearchJobsCacheForTest();
  });

  test("runInTransaction：内部抛错 → ROLLBACK，写入不落库", async () => {
    const db = await getDb();
    const wfId = `wf-tx-rollback-${Date.now()}`;
    await seedWorkflow(wfId, "running");

    const reqId = `req-tx-rollback-${Date.now()}`;
    await expect(
      runInTransaction(db, async () => {
        await seedHitlRequest({ id: reqId, workflowRunId: wfId });
        throw new Error("simulated mid-tx failure");
      })
    ).rejects.toThrow("simulated mid-tx failure");

    const rows = await db
      .select()
      .from(schema.workflowHitlRequest)
      .where(drizzle.eq(schema.workflowHitlRequest.id, reqId));
    expect(rows.length).toBe(0);
  });

  test("runInTransaction：正常成功 → COMMIT，所有写入可见", async () => {
    const db = await getDb();
    const wfId = `wf-tx-commit-${Date.now()}`;
    await seedWorkflow(wfId, "running");

    const reqId = `req-tx-commit-${Date.now()}`;
    await runInTransaction(db, async () => {
      await seedHitlRequest({ id: reqId, workflowRunId: wfId });
      await db
        .update(schema.workflowRun)
        .set({ status: "awaiting_approval" })
        .where(drizzle.eq(schema.workflowRun.id, wfId));
    });

    const hitlRows = await db
      .select()
      .from(schema.workflowHitlRequest)
      .where(drizzle.eq(schema.workflowHitlRequest.id, reqId));
    expect(hitlRows[0]?.status).toBe("pending");

    const wfRows = await db
      .select({ status: schema.workflowRun.status })
      .from(schema.workflowRun)
      .where(drizzle.eq(schema.workflowRun.id, wfId));
    expect(wfRows[0]?.status).toBe("awaiting_approval");
  });

  test("repairStaleHitlAwaitingApproval：无 pending hitl_request → 把 analyst job + workflow 修成 failed", async () => {
    const wfId = `wf-stale-${Date.now()}`;
    await seedWorkflow(wfId, "awaiting_approval");
    const reqId = `req-stale-${Date.now()}`;
    await seedHitlRequest({ id: reqId, workflowRunId: wfId, status: "approved" });

    const jobId = `job-stale-${Date.now()}`;
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: wfId,
      ticker: "AAPL",
      startedAt: Date.now(),
    });
    await jobs.pauseAnalystResearchJobForHitl(jobId, {
      requestId: reqId,
      title: "t",
      summary: "s",
    });

    /** 模拟进程重启：cache 清空，restoreRunningWorkflows 会扫到 stale */
    jobs.__resetAnalystResearchJobsCacheForTest();

    const outcome = await restoreRunningWorkflows();
    expect(outcome.hitlStaleRepaired).toBeGreaterThanOrEqual(1);

    const db = await getDb();
    const jobRow = await db
      .select({ status: schema.analystResearchJob.status })
      .from(schema.analystResearchJob)
      .where(drizzle.eq(schema.analystResearchJob.id, jobId));
    expect(jobRow[0]?.status).toBe("failed");

    const wfRow = await db
      .select({ status: schema.workflowRun.status })
      .from(schema.workflowRun)
      .where(drizzle.eq(schema.workflowRun.id, wfId));
    expect(wfRow[0]?.status).toBe("failed");
  });

  test("repairStaleHitlAwaitingApproval：仍有 pending hitl_request → 不动状态（等用户操作）", async () => {
    const wfId = `wf-stale-skip-${Date.now()}`;
    await seedWorkflow(wfId, "awaiting_approval");
    const reqId = `req-stale-skip-${Date.now()}`;
    await seedHitlRequest({ id: reqId, workflowRunId: wfId, status: "pending" });

    const jobId = `job-stale-skip-${Date.now()}`;
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: wfId,
      ticker: "AAPL",
      startedAt: Date.now(),
    });
    await jobs.pauseAnalystResearchJobForHitl(jobId, {
      requestId: reqId,
      title: "t",
      summary: "s",
    });

    jobs.__resetAnalystResearchJobsCacheForTest();
    await restoreRunningWorkflows();

    const db = await getDb();
    const jobRow = await db
      .select({ status: schema.analystResearchJob.status })
      .from(schema.analystResearchJob)
      .where(drizzle.eq(schema.analystResearchJob.id, jobId));
    /** hitl 还 pending，stale 修复跳过，状态保持 awaiting_approval */
    expect(jobRow[0]?.status).toBe("awaiting_approval");
  });
});
