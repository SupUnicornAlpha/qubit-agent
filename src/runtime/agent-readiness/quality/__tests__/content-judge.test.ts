/**
 * A-3 LLM-as-Judge 测试。用 mock JudgeClient（不调真 LLM）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-aqm-judge-${process.pid}-${Date.now()}`);
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
const { collectContentJudge } = await import("../content-judge");
const { parseJudgeResponse } = await import("../content-judge-rubric");

const PROJECT_ID = "proj-aqm-judge";
const WS_ID = "ws-aqm-judge";

async function setupResearchWorkflow(): Promise<string> {
  const db = await getDb();
  const wfId = `wf-${crypto.randomUUID()}`;
  await db.insert(schema.workflowRun).values({
    id: wfId,
    projectId: PROJECT_ID,
    sessionId: null,
    goal: "judge",
    mode: "research",
    source: "api",
    status: "completed",
  });
  await db.insert(schema.analystSignal).values({
    id: `as-${wfId}`,
    workflowRunId: wfId,
    analystRole: "fundamental",
    ticker: "AAPL",
    signal: "buy",
    confidence: 0.7,
    reasoning: "Q3 业绩同比+15%，毛利率 45% 抬升",
  });
  await db.insert(schema.signalFusionResult).values({
    id: `sf-${wfId}`,
    workflowRunId: wfId,
    ticker: "AAPL",
    fusedSignal: "buy",
    fusedConfidence: 0.6,
  });
  return wfId;
}

describe("A-3 LLM-as-Judge", () => {
  beforeAll(async () => {
    await runMigrations();
    const db = await getDb();
    await db
      .insert(schema.workspace)
      .values({ id: WS_ID, name: "judge-ws", owner: "test" })
      .onConflictDoNothing();
    await db
      .insert(schema.project)
      .values({
        id: PROJECT_ID,
        workspaceId: WS_ID,
        name: "judge-proj",
        marketScope: "us",
      })
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeDb();
  });

  test("parseJudgeResponse 容忍 ```json fence", () => {
    const raw =
      "```json\n" +
      JSON.stringify({
        scores: {
          data_grounding: 4,
          quantification: 3,
          reasoning_chain: 4,
          citations: 2,
          risk_awareness: 3,
        },
        issues: ["missing risk"],
        overall: 3.2,
      }) +
      "\n```";
    const r = parseJudgeResponse(raw);
    expect(r).not.toBeNull();
    expect(r!.scores.data_grounding).toBe(4);
    // overall 重新计算 = (4+3+4+2+3)/5 = 3.2
    expect(r!.overall).toBeCloseTo(3.2, 1);
  });

  test("parseJudgeResponse 解析失败 → null（不抛错）", () => {
    expect(parseJudgeResponse("not json")).toBeNull();
    expect(parseJudgeResponse("{}")).toBeNull();
  });

  test("collectContentJudge：mock judge 全成功 → A-3 是均值", async () => {
    const wfId = await setupResearchWorkflow();
    const sqlite = getSqliteForTesting();
    let calls = 0;
    const client = {
      judge: async () => {
        calls++;
        return JSON.stringify({
          scores: {
            data_grounding: 4,
            quantification: 4,
            reasoning_chain: 4,
            citations: 4,
            risk_awareness: 4,
          },
          issues: [],
          overall: 4.0,
        });
      },
    };
    const r = await collectContentJudge(sqlite, client, {
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(calls).toBe(2); // 1 analyst_signal + 1 fusion
    expect(r["A-3"]).toBeCloseTo(4.0, 2);
    expect(r.details.judged).toHaveLength(2);
    expect(r.details.failed).toHaveLength(0);
  });

  test("collectContentJudge：1 个 judge 失败 + 1 个成功 → A-3 = 成功项均值，failed 列表非空", async () => {
    const wfId = await setupResearchWorkflow();
    const sqlite = getSqliteForTesting();
    let n = 0;
    const client = {
      judge: async () => {
        n++;
        if (n === 1) throw new Error("upstream timeout");
        return JSON.stringify({
          scores: {
            data_grounding: 5,
            quantification: 5,
            reasoning_chain: 5,
            citations: 5,
            risk_awareness: 5,
          },
          issues: [],
          overall: 5.0,
        });
      },
    };
    const r = await collectContentJudge(sqlite, client, {
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(r["A-3"]).toBe(5.0);
    expect(r.details.judged).toHaveLength(1);
    expect(r.details.failed).toHaveLength(1);
    expect(r.details.failed[0].reason).toContain("upstream timeout");
  });

  test("collectContentJudge：全失败 → A-3=null", async () => {
    const wfId = await setupResearchWorkflow();
    const sqlite = getSqliteForTesting();
    const client = {
      judge: async () => {
        throw new Error("rate limited");
      },
    };
    const r = await collectContentJudge(sqlite, client, {
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(r["A-3"]).toBeNull();
    expect(r.details.judged).toHaveLength(0);
    expect(r.details.failed.length).toBeGreaterThan(0);
  });

  test("collectContentJudge：无产物 → A-3=null（不调 judge）", async () => {
    const db = await getDb();
    const wfId = `wf-empty-${crypto.randomUUID()}`;
    await db.insert(schema.workflowRun).values({
      id: wfId,
      projectId: PROJECT_ID,
      sessionId: null,
      goal: "empty",
      mode: "research",
      source: "api",
      status: "completed",
    });
    const sqlite = getSqliteForTesting();
    let called = false;
    const client = {
      judge: async () => {
        called = true;
        return "{}";
      },
    };
    const r = await collectContentJudge(sqlite, client, {
      workflowRunId: wfId,
      scenario: "research",
    });
    expect(called).toBe(false);
    expect(r["A-3"]).toBeNull();
  });
});
