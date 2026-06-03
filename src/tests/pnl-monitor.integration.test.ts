/**
 * P4b 后端 PnL 路由集成测：
 *   GET /api/v1/monitor/pnl/strategies — 按 (runtime, symbol) 聚合范围内 daily PnL
 *   GET /api/v1/monitor/pnl/skills — 按 project 列 skill 30 天滚动 rollup
 *
 * Fixture：建一个 project + 一个 runtime + N 天 strategy_pnl_snapshot；建 1 个 skill
 * 并预填 pnl_attribution_json。然后通过 Hono `app.request` 调路由验证返回结构。
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { closeDb, getDb } from "../db/sqlite/client";
import { runMigrations } from "../db/sqlite/migrate";
import {
  agentDefinition,
  agentSkill,
  chatSession,
  indicatorStrategyScript,
  project,
  sandboxPolicy,
  strategyPnlSnapshot,
  strategyRuntime,
  workspace,
} from "../db/sqlite/schema";

async function jsonOf(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

let app: { request: (req: Request) => Promise<Response> };
let projectId = "";
let runtimeUSId = "";
let skillId = "";

beforeAll(async () => {
  const testHome = `${process.cwd()}/.tmp-test-home-pnl`;
  await rm(testHome, { recursive: true, force: true });
  await mkdir(testHome, { recursive: true });
  process.env.HOME = testHome;
  process.env.QUBIT_DATA_DIR = testHome;
  closeDb();
  await runMigrations();
  const server = await import("../server");
  app = server.app;

  const db = await getDb();
  const workspaceId = `ws_${randomUUID()}`;
  projectId = `prj_${randomUUID()}`;
  const chatSessionId = `cs_${randomUUID()}`;
  const scriptId = `script_${randomUUID()}`;
  runtimeUSId = `rt_${randomUUID()}`;
  skillId = `skill_${randomUUID()}`;
  const sandboxPolicyId = `sp_${randomUUID()}`;
  const definitionId = `def_${randomUUID()}`;

  await db.insert(workspace).values({ id: workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: projectId, workspaceId, name: "p", marketScope: "US" })
    .run();
  await db.insert(chatSession).values({ id: chatSessionId, workspaceId, title: "t" }).run();
  await db
    .insert(indicatorStrategyScript)
    .values({ id: scriptId, sessionId: chatSessionId, name: "test-script" })
    .run();
  await db
    .insert(strategyRuntime)
    .values({
      id: runtimeUSId,
      strategyScriptId: scriptId,
      market: "US",
      symbol: "AAPL",
      executionMode: "paper",
    })
    .run();
  await db.insert(sandboxPolicy).values({ id: sandboxPolicyId, name: "p" }).run();
  await db
    .insert(agentDefinition)
    .values({
      id: definitionId,
      role: "analyst",
      name: "a",
      systemPrompt: "sp",
      llmProvider: "openai",
      sandboxPolicyId,
    })
    .run();
  await db
    .insert(agentSkill)
    .values({
      id: skillId,
      projectId,
      definitionId,
      name: "test_skill",
      pnlAttributionJson: JSON.stringify({
        windowDays: 30,
        pnlSum: 150.5,
        winCount: 7,
        loseCount: 2,
        sampleCount: 9,
        lastUpdatedAt: "2026-06-01T00:00:00Z",
      }),
      useCount: 12,
      successCount: 7,
      failCount: 2,
    })
    .run();
  // 写 3 天 snapshot
  for (const [day, real, unreal, fee, qty, mark] of [
    ["2026-06-01", 0, 200, 1, 100, 152],
    ["2026-06-02", 100, 50, 0.5, 70, 153],
    ["2026-06-03", -20, 30, 0.3, 70, 151],
  ] as const) {
    await db
      .insert(strategyPnlSnapshot)
      .values({
        id: `pnl_${randomUUID()}`,
        strategyRuntimeId: runtimeUSId,
        tradingDay: day,
        symbol: "AAPL",
        qty,
        avgCost: 150,
        markPrice: mark,
        marketValue: qty * mark,
        realizedPnlDaily: real,
        unrealizedPnlDaily: unreal,
        realizedPnlCum: real,
        unrealizedPnlCum: unreal,
        feeDaily: fee,
        feeCum: fee,
        turnoverDaily: 0,
        source: "pnl_attributor_v0",
        metadataJson: {},
      })
      .run();
  }
});

describe("GET /api/v1/monitor/pnl/strategies", () => {
  test("覆盖范围内的 (runtime, symbol) 一行汇总", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/pnl/strategies?fromDay=2026-06-01&toDay=2026-06-03&runtimeIds=${runtimeUSId}`
      )
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    expect(j.ok).toBe(true);
    const data = j.data as { fromDay: string; toDay: string; rows: Array<Record<string, unknown>> };
    expect(data.fromDay).toBe("2026-06-01");
    expect(data.toDay).toBe("2026-06-03");
    expect(data.rows).toHaveLength(1);
    const row = data.rows[0];
    if (!row) throw new Error("missing row");
    expect(row.strategyRuntimeId).toBe(runtimeUSId);
    expect(row.symbol).toBe("AAPL");
    expect(row.market).toBe("US");
    // realized: 0 + 100 + (-20) = 80
    expect(row.realizedPnlSum).toBe(80);
    // fee: 1 + 0.5 + 0.3 = 1.8
    expect(row.feeSum).toBeCloseTo(1.8, 1);
    expect(row.daysCovered).toBe(3);
    expect(row.latestDay).toBe("2026-06-03");
    expect(row.latestQty).toBe(70);
    expect(row.latestMarkPrice).toBe(151);
    expect(row.unrealizedPnlSumLast).toBe(30);
  });

  test("marketScope=CN → 不匹配 → 空", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/pnl/strategies?fromDay=2026-06-01&toDay=2026-06-03&marketScope=CN`
      )
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    const data = j.data as { rows: unknown[] };
    expect(data.rows).toHaveLength(0);
  });

  test("limit 参数生效", async () => {
    const res = await app.request(
      new Request(
        `http://test/api/v1/monitor/pnl/strategies?fromDay=2026-06-01&toDay=2026-06-03&limit=1`
      )
    );
    const j = await jsonOf(res);
    const data = j.data as { rows: unknown[] };
    expect(data.rows.length).toBeLessThanOrEqual(1);
  });
});

describe("GET /api/v1/monitor/pnl/skills", () => {
  test("缺 projectId → 400", async () => {
    const res = await app.request(new Request(`http://test/api/v1/monitor/pnl/skills`));
    expect(res.status).toBe(400);
  });

  test("按 project 列 skill rollup", async () => {
    const res = await app.request(
      new Request(`http://test/api/v1/monitor/pnl/skills?projectId=${projectId}`)
    );
    expect(res.status).toBe(200);
    const j = await jsonOf(res);
    const data = j.data as { projectId: string; rows: Array<Record<string, unknown>> };
    expect(data.projectId).toBe(projectId);
    expect(data.rows.length).toBeGreaterThanOrEqual(1);
    const row = data.rows[0];
    if (!row) throw new Error("missing");
    expect(row.skillId).toBe(skillId);
    expect(row.name).toBe("test_skill");
    expect(row.pnlSum).toBe(150.5);
    expect(row.winCount).toBe(7);
    expect(row.loseCount).toBe(2);
    expect(row.sampleCount).toBe(9);
    expect(row.useCount).toBe(12);
    expect(row.windowDays).toBe(30);
  });
});
