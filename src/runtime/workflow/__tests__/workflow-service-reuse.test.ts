/**
 * 串台修复回归测试：`reuseSessionWorkflow` 必须按 `source` 隔离。
 *
 * 历史 bug：原 `createAndDispatchWorkflow` 在 `reuseSessionWorkflow=true` 时只按
 * `(projectId, sessionId)` 取 startedAt 最新一条复用。这导致 chat session 上沾着
 * 的非 chat 工作流（trader/scheduler 通过 trader-workflow.ts、scheduler.ts 注入的
 * `source='api'` 行）一旦比 chat workflow 更新，就会被下一次 onSend 抢走当对话流。
 * 表现：对话窗口"突然绑定到研究 Agent / Trader 流，每次回答的 workflow 都不是同一个"。
 *
 * 这里把同一 (projectId, sessionId) 上人为种入 api/chat 各一条，再以 chat 身份调
 * `createAndDispatchWorkflow`，断言：
 *   1) 复用的是较旧但 `source='chat'` 的那条，**不会**被较新的 api 行抢走；
 *   2) 没有 chat 候选时回退到"新建"，而不是错挑别的 source。
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-wf-reuse-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { afterAll, beforeAll, describe, expect, test } = await import("bun:test");
const { runMigrations } = await import("../../../db/sqlite/migrate");
const { getDb, closeDb } = await import("../../../db/sqlite/client");
const schema = await import("../../../db/sqlite/schema");
const drizzle = await import("drizzle-orm");
const { createAndDispatchWorkflow } = await import("../workflow-service");

const WORKSPACE_ID = "ws-reuse-test";
const PROJECT_ID = "proj-reuse-test";

async function seedWorkflowRow(input: {
  id: string;
  sessionId: string;
  source: "chat" | "api" | "manual";
  goal?: string;
  /** ISO 时间，越大越新 */
  startedAt: string;
}): Promise<void> {
  const db = await getDb();
  await db.insert(schema.workflowRun).values({
    id: input.id,
    projectId: PROJECT_ID,
    sessionId: input.sessionId,
    goal: input.goal ?? `seed-${input.source}`,
    mode: "research",
    source: input.source,
    status: "completed",
    startedAt: input.startedAt,
  });
}

describe("createAndDispatchWorkflow.reuseSessionWorkflow source 隔离", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "reuse-test-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "reuse-test-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("chat 复用：忽略更新的非 chat 工作流（trader/scheduler 串台修复）", async () => {
    const sessionId = "sess-reuse-chat-newer-trader";
    const chatId = "wf-chat-old";
    const apiId = "wf-api-newer-trader";

    /** chat 较旧 */
    await seedWorkflowRow({
      id: chatId,
      sessionId,
      source: "chat",
      goal: "chat-first-turn",
      startedAt: "2024-01-01T00:00:00.000Z",
    });
    /** 之后用户在 IDE/Trader 面板触发，写入了一条更新的 source='api' 行 */
    await seedWorkflowRow({
      id: apiId,
      sessionId,
      source: "api",
      goal: "QUBIT 实时交易 Agent 执行上下文",
      startedAt: "2024-06-01T00:00:00.000Z",
    });

    const created = await createAndDispatchWorkflow({
      projectId: PROJECT_ID,
      sessionId,
      goal: "chat-second-turn",
      mode: "research",
      source: "chat",
      reuseSessionWorkflow: true,
      skipDispatch: true,
    });

    /** 1) 必须挑 chat 那条，而不是更新的 api 那条 */
    expect(created.data.id).toBe(chatId);
    expect(created.data.id).not.toBe(apiId);
    /** 2) 复用后 goal/source 被改成 chat 的本轮值 */
    expect(created.data.source).toBe("chat");
    expect(created.data.goal).toBe("chat-second-turn");

    /** 3) trader 那条没被动到（goal/source/status 都保留） */
    const db = await getDb();
    const traderRow = await db
      .select()
      .from(schema.workflowRun)
      .where(drizzle.eq(schema.workflowRun.id, apiId))
      .limit(1);
    expect(traderRow[0]?.source).toBe("api");
    expect(traderRow[0]?.goal).toBe("QUBIT 实时交易 Agent 执行上下文");
  });

  test("chat 复用：session 上仅有非 chat 工作流时回退新建", async () => {
    const sessionId = "sess-reuse-no-chat-candidate";
    const apiId = "wf-api-only";
    await seedWorkflowRow({
      id: apiId,
      sessionId,
      source: "api",
      goal: "QUBIT 实时交易 Agent 执行上下文",
      startedAt: "2024-06-01T00:00:00.000Z",
    });

    const created = await createAndDispatchWorkflow({
      projectId: PROJECT_ID,
      sessionId,
      goal: "chat-first-turn",
      mode: "research",
      source: "chat",
      reuseSessionWorkflow: true,
      skipDispatch: true,
    });

    /** 不复用 api 行，而是新建一条 chat 工作流 */
    expect(created.data.id).not.toBe(apiId);
    expect(created.data.source).toBe("chat");
    expect(created.data.goal).toBe("chat-first-turn");

    /** trader 行依旧不被污染 */
    const db = await getDb();
    const traderRow = await db
      .select()
      .from(schema.workflowRun)
      .where(drizzle.eq(schema.workflowRun.id, apiId))
      .limit(1);
    expect(traderRow[0]?.source).toBe("api");
    expect(traderRow[0]?.goal).toBe("QUBIT 实时交易 Agent 执行上下文");
  });
});
