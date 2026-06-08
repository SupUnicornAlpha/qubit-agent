/**
 * C 类 · LLM 调用质量与适配（C-1/C-2/C-3/C-5）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-aqm-llm-${process.pid}-${Date.now()}`);
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
const { collectLlmQuality } = await import("../llm-quality");

const WORKSPACE_ID = "ws-aqm-llm";
const PROJECT_ID = "proj-aqm-llm";

async function setupWf(): Promise<string> {
  const db = await getDb();
  const wfId = `wf-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id: wfId,
    projectId: PROJECT_ID,
    sessionId: null,
    goal: "llm",
    mode: "research",
    source: "api",
    status: "completed",
  });
  return wfId;
}

async function insertLlm(opts: {
  wfId: string;
  i: number;
  status?: "success" | "error" | "timeout" | "fallback";
  totalTokens?: number;
  finishReason?: string;
}) {
  const db = await getDb();
  await db.insert(schema.llmCallLog).values({
    id: `llm-${opts.i}-${opts.wfId}`,
    workflowRunId: opts.wfId,
    provider: "openai",
    model: "gpt-5.5-medium",
    latencyMs: 100,
    status: opts.status ?? "success",
    ...(opts.totalTokens !== undefined ? { totalTokens: opts.totalTokens } : {}),
    ...(opts.finishReason ? { finishReason: opts.finishReason } : {}),
  } as never);
}

describe("C 类 · LLM 调用质量", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WORKSPACE_ID, name: "lq-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        name: "lq-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("C-1 调用成功率：8 success + 2 error → 0.8", async () => {
    const wfId = await setupWf();
    for (let i = 0; i < 8; i++) await insertLlm({ wfId, i, status: "success" });
    for (let i = 8; i < 10; i++) await insertLlm({ wfId, i, status: "error" });
    const sqlite = getSqliteForTesting();
    const r = await collectLlmQuality(sqlite, wfId);
    expect(r["C-1"]).toBeCloseTo(0.8, 5);
  });

  test("C-2 主路径失败比例：6 success + 2 error + 1 timeout + 1 fallback → 0.4", async () => {
    const wfId = await setupWf();
    for (let i = 0; i < 6; i++) await insertLlm({ wfId, i, status: "success" });
    await insertLlm({ wfId, i: 6, status: "error" });
    await insertLlm({ wfId, i: 7, status: "error" });
    await insertLlm({ wfId, i: 8, status: "timeout" });
    await insertLlm({ wfId, i: 9, status: "fallback" });
    const sqlite = getSqliteForTesting();
    const r = await collectLlmQuality(sqlite, wfId);
    expect(r["C-2"]).toBeCloseTo(0.4, 5);
  });

  test("C-3 token：单次 max + 总和 + p95 都返回", async () => {
    const wfId = await setupWf();
    for (let i = 0; i < 100; i++)
      await insertLlm({ wfId, i, totalTokens: 1000 + i * 10 });
    const sqlite = getSqliteForTesting();
    const r = await collectLlmQuality(sqlite, wfId);
    expect(r["C-3-total"]).toBeGreaterThan(0);
    // p95 应在 [1900, 2000] 之间
    expect(r["C-3-p95"]).toBeGreaterThan(1800);
    expect(r["C-3-p95"]).toBeLessThan(2050);
  });

  test("C-5 输出格式合规：5 stop + 1 length → 1/6 ≈ 0.167（截断率）", async () => {
    const wfId = await setupWf();
    for (let i = 0; i < 5; i++)
      await insertLlm({ wfId, i, finishReason: "stop" });
    await insertLlm({ wfId, i: 5, finishReason: "length" });
    const sqlite = getSqliteForTesting();
    const r = await collectLlmQuality(sqlite, wfId);
    // C-5 = 截断率
    expect(r["C-5"]).toBeCloseTo(1 / 6, 2);
  });

  test("空 workflow → C-1=null（不能算 0），C-2=null，C-3-total=0，C-5=null", async () => {
    const wfId = await setupWf();
    const sqlite = getSqliteForTesting();
    const r = await collectLlmQuality(sqlite, wfId);
    expect(r["C-1"]).toBeNull();
    expect(r["C-2"]).toBeNull();
    expect(r["C-3-total"]).toBe(0);
    expect(r["C-5"]).toBeNull();
  });
});
