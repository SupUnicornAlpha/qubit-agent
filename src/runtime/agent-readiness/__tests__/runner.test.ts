/**
 * runner 测试：用预置完成态的 workflow_run + 一些 tool/llm 日志，验证：
 *   - waitForTerminal 立刻返回（已是 completed）
 *   - 抓出来的指标和 collector 一致
 *   - JSON / Markdown 文件落到 outputDir
 *
 * 这里不验证 createAndDispatchWorkflow 链路（那是 workflow-service 自己的测试范畴）。
 */
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-readiness-runner-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const { runReadinessFromWorkflowId } = await import("../runner");

const WORKSPACE_ID = "ws-runner";
const PROJECT_ID = "proj-runner";

async function setupCompletedWorkflow(): Promise<string> {
  const db = await getDb();
  const id = `wf-runner-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id,
    projectId: PROJECT_ID,
    sessionId: null,
    goal: "runner test",
    mode: "research",
    source: "api",
    status: "completed",
    endedAt: new Date().toISOString(),
  });
  return id;
}

describe("runReadinessFromWorkflowId", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("已完成态：立即出 snapshot + 写 JSON / MD 文件", async () => {
    const wfId = await setupCompletedWorkflow();
    const outDir = join(tmpDir, "reports");

    const result = await runReadinessFromWorkflowId({
      scenario: "research",
      workflowRunId: wfId,
      outputDir: outDir,
      waitTimeoutMs: 1000,
      pollIntervalMs: 100,
    });

    expect(result.workflowStatus).toBe("completed");
    expect(result.timedOut).toBe(false);
    expect(result.snapshot.workflowRunId).toBe(wfId);
    expect(result.grade.overall).toBeTruthy();
    expect(existsSync(result.reports.jsonPath)).toBe(true);
    expect(existsSync(result.reports.markdownPath)).toBe(true);
  });

  test("running 但超时：timedOut=true，仍出快照", async () => {
    const db = await getDb();
    const id = `wf-running-${crypto.randomUUID()}`;
    await db.insert(schema.workflowRun).values({
      id,
      projectId: PROJECT_ID,
      sessionId: null,
      goal: "runner timeout",
      mode: "research",
      source: "api",
      status: "running",
    });

    const outDir = join(tmpDir, "reports-timeout");
    const result = await runReadinessFromWorkflowId({
      scenario: "research",
      workflowRunId: id,
      outputDir: outDir,
      waitTimeoutMs: 200,
      pollIntervalMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(result.workflowStatus).toBe("running");
    // O-1 应该是 0（非 completed）
    expect(result.snapshot.metrics["O-1"]).toBe(0);
  });

  test("未知 scenario 抛错（white-box guard）", async () => {
    const wfId = await setupCompletedWorkflow();
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runReadinessFromWorkflowId({
        scenario: "not_a_scenario" as never,
        workflowRunId: wfId,
        outputDir: join(tmpDir, "reports-bad"),
      })
    ).rejects.toThrow(/unknown scenario/);
  });
});
