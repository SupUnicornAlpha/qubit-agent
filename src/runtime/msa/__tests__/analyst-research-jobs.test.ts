/**
 * P0-2：研究团队异步任务（analyst_research_job）落库 + cache 行为快照。
 *
 * 旧实现纯 in-memory Map：进程重启 → cache 丢 → 前端轮询 404，HITL 审批链路断。
 * 新实现 DB 真相源，cache 仅作热路径加速；本测试验证：
 *   1. register / pause / complete / fail 都正确落库 + 同步更新 cache
 *   2. cache 清空（模拟进程重启）后，read API 依然能从 DB 取到完整状态
 *   3. rehydrateAnalystResearchJobsCache 能把 running / awaiting_approval 回填
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-analyst-jobs-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, beforeEach, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const jobs = await import("../analyst-research-jobs");

type ParsedResearchTeamExecute = import("../research-team-execute").ParsedResearchTeamExecute;
type AnalystTeamResult = import("../analyst-team").AnalystTeamResult;

const WORKSPACE_ID = "ws-test";
const PROJECT_ID = "proj-test";
const WORKFLOW_ID = "wf-analyst-test";
const WORKFLOW_ID_2 = "wf-analyst-test-2";

async function seedWorkflow(workflowId: string): Promise<void> {
  const db = await getDb();
  await db
    .insert(schema.workflowRun)
    .values({
      id: workflowId,
      projectId: PROJECT_ID,
      goal: "test",
      mode: "research",
      source: "api",
      status: "running",
    })
    .onConflictDoNothing();
}

describe("analyst_research_job persistence (P0-2)", () => {
  beforeAll(async () => {
    closeDb();
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "test", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({ id: PROJECT_ID, workspaceId: WORKSPACE_ID, name: "p", marketScope: "us" })
      .onConflictDoNothing();
    await seedWorkflow(WORKFLOW_ID);
    await seedWorkflow(WORKFLOW_ID_2);
  });

  afterAll(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jobs.__resetAnalystResearchJobsCacheForTest();
  });

  test("register 写 DB + cache 命中", async () => {
    const jobId = `job-${Date.now()}-1`;
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: WORKFLOW_ID,
      ticker: "AAPL",
      startedAt: Date.now(),
    });

    const fromCache = await jobs.getAnalystResearchJob(jobId);
    expect(fromCache?.status).toBe("running");
    expect(fromCache?.ticker).toBe("AAPL");
  });

  test("cache 清空（模拟进程重启）后 DB 仍能查到完整状态", async () => {
    const jobId = `job-${Date.now()}-2`;
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: WORKFLOW_ID,
      ticker: "TSLA",
      startedAt: Date.now(),
    });

    jobs.__resetAnalystResearchJobsCacheForTest();

    const fromDb = await jobs.getAnalystResearchJob(jobId);
    expect(fromDb).toBeDefined();
    expect(fromDb?.status).toBe("running");
    expect(fromDb?.ticker).toBe("TSLA");
    expect(fromDb?.workflowRunId).toBe(WORKFLOW_ID);
  });

  test("pause 把 resumePayload + HITL 信息落到 DB；重启后 resume 仍能拿回", async () => {
    const jobId = `job-${Date.now()}-3`;
    const resumePayload: ParsedResearchTeamExecute = {
      jobId,
      ticker: "NVDA",
      scope: null,
      agentGroupId: null,
    };
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: WORKFLOW_ID,
      ticker: "NVDA",
      startedAt: Date.now(),
    });
    await jobs.pauseAnalystResearchJobForHitl(jobId, {
      requestId: "hitl-req-42",
      title: "审批 NVDA 团队规划",
      summary: "拟启用 5 个分析师",
      resumePayload,
    });

    /** 模拟进程重启：清掉 cache，依旧能从 DB 找到 + 拿回 resumePayload */
    jobs.__resetAnalystResearchJobsCacheForTest();

    const pending = await jobs.findPendingAnalystJobByWorkflow(WORKFLOW_ID);
    expect(pending?.jobId).toBe(jobId);
    expect(pending?.job.status).toBe("awaiting_approval");
    expect(pending?.job.hitlRequestId).toBe("hitl-req-42");
    expect(pending?.job.hitlTitle).toContain("NVDA");

    const resumed = await jobs.resumeAnalystResearchJob(jobId);
    expect(resumed).toBeDefined();
    expect(resumed?.ticker).toBe("NVDA");
    expect(resumed?.jobId).toBe(jobId);

    /** resume 后状态应回到 running，hitl 字段清空 */
    const after = await jobs.getAnalystResearchJob(jobId);
    expect(after?.status).toBe("running");
    expect(after?.hitlRequestId).toBeUndefined();
  });

  test("complete 落 result JSON + 状态 + endedAt；重启后仍能取回 result", async () => {
    const jobId = `job-${Date.now()}-4`;
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: WORKFLOW_ID,
      ticker: "AMD",
      startedAt: Date.now(),
    });
    const result = {
      fusionId: "fus-amd-1",
      fusedSignal: "long",
      fusedConfidence: 0.71,
    } as unknown as AnalystTeamResult;
    await jobs.completeAnalystResearchJob(jobId, result);

    jobs.__resetAnalystResearchJobsCacheForTest();
    const fromDb = await jobs.getAnalystResearchJob(jobId);
    expect(fromDb?.status).toBe("completed");
    expect((fromDb?.result as unknown as { fusionId: string })?.fusionId).toBe("fus-amd-1");
    expect(fromDb?.endedAt).toBeGreaterThan(0);
  });

  test("fail 落 errorMessage + 状态；重启后仍能取回", async () => {
    const jobId = `job-${Date.now()}-5`;
    await jobs.registerAnalystResearchJob(jobId, {
      status: "running",
      workflowRunId: WORKFLOW_ID,
      ticker: "MSFT",
      startedAt: Date.now(),
    });
    await jobs.failAnalystResearchJob(jobId, new Error("provider 429"));

    jobs.__resetAnalystResearchJobsCacheForTest();
    const fromDb = await jobs.getAnalystResearchJob(jobId);
    expect(fromDb?.status).toBe("failed");
    expect(fromDb?.error).toContain("provider 429");
  });

  test("findActiveAnalystJobsByWorkflow 合并 cache + DB", async () => {
    const a = `job-${Date.now()}-6a`;
    const b = `job-${Date.now()}-6b`;
    await jobs.registerAnalystResearchJob(a, {
      status: "running",
      workflowRunId: WORKFLOW_ID_2,
      ticker: "X",
      startedAt: Date.now(),
    });
    await jobs.registerAnalystResearchJob(b, {
      status: "running",
      workflowRunId: WORKFLOW_ID_2,
      ticker: "Y",
      startedAt: Date.now(),
    });
    await jobs.pauseAnalystResearchJobForHitl(b, {
      requestId: "req-b",
      title: "t",
      summary: "s",
    });

    /** 清掉 cache 只剩 DB；findActive 应该仍能两条都列出 */
    jobs.__resetAnalystResearchJobsCacheForTest();
    const ids = await jobs.findActiveAnalystJobsByWorkflow(WORKFLOW_ID_2);
    expect(ids.sort()).toEqual([a, b].sort());
  });

  test("rehydrateAnalystResearchJobsCache 把所有 running / awaiting_approval 灌回 cache", async () => {
    /** 当前 WORKFLOW_ID + WORKFLOW_ID_2 都已有数条记录；多个状态混在一起 */
    jobs.__resetAnalystResearchJobsCacheForTest();
    const n = await jobs.rehydrateAnalystResearchJobsCache();
    expect(n).toBeGreaterThan(0);

    /** cache miss 不再回查 DB，但能立即命中 cache */
    const db = await getDb();
    const liveRows = await db
      .select({ id: schema.analystResearchJob.id, status: schema.analystResearchJob.status })
      .from(schema.analystResearchJob);
    const liveActive = liveRows.filter(
      (r) => r.status === "running" || r.status === "awaiting_approval"
    );
    expect(n).toBe(liveActive.length);
  });
});
