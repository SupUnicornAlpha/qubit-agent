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
});
