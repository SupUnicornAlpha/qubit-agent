/**
 * P4a analyst-accuracy-writer 单测：覆盖占位幂等 / 评估 up/down/flat / mark 缺失 / ticker 推断 / hold 正确判定。
 *
 * 注意：为避免依赖 agentInstance / agentDefinition 真实 schema 复杂度（FK 约束），
 * 测试直接插 analyst_signal（agentInstanceId=null → 走 'analyst-role:' 兜底 definitionId）。
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { analystAccuracyLog, analystSignal, dailyMarkPrice } from "../../../db/sqlite/schema";
import {
  type AnalystAccuracyWriter,
  computeIsCorrect,
  createAnalystAccuracyWriter,
  defaultTickerToMarket,
  nextNTradingDays,
} from "../analyst-accuracy-writer";
import { dateToEpochDay, dateToTradingDay } from "../time-util";

let writer: AnalystAccuracyWriter;
// 全局 fixture：sandbox_policy + agent_definition + agent_instance + workflow_run
let fixture: {
  sandboxPolicyId: string;
  definitionId: string;
  agentInstanceId: string;
  workflowRunId: string;
  workspaceId: string;
  projectId: string;
};

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p4a-aaw-${Date.now()}`);
  await runMigrations();
  const db = await getDb();
  writer = createAnalystAccuracyWriter(db);

  // 建一次性 fixture（FK 链：workspace → project → workflow_run；sandbox_policy → agent_definition → agent_instance）
  const workspaceId = `ws_${randomUUID()}`;
  const projectId = `prj_${randomUUID()}`;
  const workflowRunId = `wf_${randomUUID()}`;
  const sandboxPolicyId = `sp_${randomUUID()}`;
  const definitionId = `def_${randomUUID()}`;
  const agentInstanceId = `ai_${randomUUID()}`;
  await db.run(`INSERT INTO workspace (id, name, owner) VALUES ('${workspaceId}', 't', 'tester')`);
  await db.run(
    `INSERT INTO project (id, workspace_id, name, market_scope) VALUES ('${projectId}', '${workspaceId}', 'p', 'CN')`
  );
  await db.run(
    `INSERT INTO workflow_run (id, project_id, goal, mode) VALUES ('${workflowRunId}', '${projectId}', 'g', 'live')`
  );
  await db.run(
    `INSERT INTO sandbox_policy (id, name) VALUES ('${sandboxPolicyId}', 'test-policy')`
  );
  await db.run(
    `INSERT INTO agent_definition (id, role, name, system_prompt, llm_provider, sandbox_policy_id) VALUES ('${definitionId}', 'analyst_fundamental', 'test-analyst', 'sp', 'openai', '${sandboxPolicyId}')`
  );
  await db.run(
    `INSERT INTO agent_instance (id, definition_id, workflow_run_id) VALUES ('${agentInstanceId}', '${definitionId}', '${workflowRunId}')`
  );
  fixture = {
    sandboxPolicyId,
    definitionId,
    agentInstanceId,
    workflowRunId,
    workspaceId,
    projectId,
  };
});

beforeEach(async () => {
  const db = await getDb();
  await db.delete(analystAccuracyLog).run();
  await db.delete(analystSignal).run();
  await db.delete(dailyMarkPrice).run();
});

async function insertSignal(opts: {
  ticker: string;
  signal: "buy" | "sell" | "hold";
  role: string;
  daysAgo: number;
  /** 默认走 fixture agentInstanceId；传 null 测 skippedNoAgent 路径 */
  agentInstanceId?: string | null;
}) {
  const db = await getDb();
  const agentInstanceId =
    opts.agentInstanceId === undefined ? fixture.agentInstanceId : opts.agentInstanceId;
  const createdAt = new Date(Date.now() - opts.daysAgo * 86_400_000).toISOString();
  await db
    .insert(analystSignal)
    .values({
      id: `as_${randomUUID()}`,
      workflowRunId: fixture.workflowRunId,
      agentInstanceId,
      analystRole: opts.role,
      ticker: opts.ticker,
      signal: opts.signal,
      confidence: 0.7,
      reasoning: "test",
      dataSnapshotJson: {},
      createdAt,
    })
    .run();
}

async function insertMark(market: string, symbol: string, day: string, close: number) {
  const db = await getDb();
  await db
    .insert(dailyMarkPrice)
    .values({
      id: `dmp_${randomUUID()}`,
      market,
      symbol,
      tradingDay: day,
      close,
      source: "test",
    })
    .run();
}

describe("syncPlaceholders", () => {
  test("空 signals → 不写", async () => {
    const r = await writer.syncPlaceholders({ lookbackDays: 30 });
    expect(r.scannedSignals).toBe(0);
    expect(r.placeholdersInserted).toBe(0);
  });

  test("一个 signal 写一行占位（agentInstance 命中真实 definition）", async () => {
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 3 });
    const r = await writer.syncPlaceholders({ lookbackDays: 30 });
    expect(r.scannedSignals).toBe(1);
    expect(r.placeholdersInserted).toBe(1);
    expect(r.skippedNoAgent).toBe(0);

    const db = await getDb();
    const rows = await db.select().from(analystAccuracyLog).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("unreachable: rows asserted to have length 1");
    expect(row.definitionId).toBe(fixture.definitionId);
    expect(row.ticker).toBe("AAPL");
    expect(row.predictedSignal).toBe("buy");
    expect(row.isCorrect).toBeNull();
    expect(row.evaluatedAt).toBeNull();
  });

  test("agentInstanceId=null → 跳过（不污染 FK），不写占位", async () => {
    await insertSignal({
      ticker: "AAPL",
      signal: "buy",
      role: "bull",
      daysAgo: 3,
      agentInstanceId: null,
    });
    const r = await writer.syncPlaceholders();
    expect(r.scannedSignals).toBe(1);
    expect(r.placeholdersInserted).toBe(0);
    expect(r.skippedNoAgent).toBe(1);
  });

  test("幂等：同一 signal 跑两次只写一行", async () => {
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 3 });
    await writer.syncPlaceholders();
    const r2 = await writer.syncPlaceholders();
    expect(r2.placeholdersInserted).toBe(0);
    expect(r2.alreadyExists).toBe(1);
  });

  test("lookback 窗口外的 signal 不被扫到", async () => {
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 60 });
    const r = await writer.syncPlaceholders({ lookbackDays: 30 });
    expect(r.scannedSignals).toBe(0);
    expect(r.placeholdersInserted).toBe(0);
  });
});

describe("evaluatePending — actualOutcome 推断", () => {
  test("buy + up → isCorrect=1", async () => {
    const signalDate = new Date(Date.now() - 10 * 86_400_000);
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 10 });
    await writer.syncPlaceholders();
    // start mark (signalDate)
    await insertMark("US", "AAPL", dateToTradingDay(signalDate, "US"), 100);
    // end mark (+5 trading days)
    const endDate = nextNTradingDays(signalDate, 5, "US");
    await insertMark("US", "AAPL", dateToTradingDay(endDate, "US"), 105); // +5%

    const r = await writer.evaluatePending({
      evalDelayDays: 5,
      upThreshold: 0.02,
      downThreshold: -0.02,
    });
    expect(r.scanned).toBe(1);
    expect(r.evaluated).toBe(1);

    const db = await getDb();
    const row = await db.select().from(analystAccuracyLog).get();
    expect(row?.actualOutcome).toBe("up");
    expect(row?.isCorrect).toBe(1);
    expect(row?.evaluatedAt).toBe(dateToEpochDay(new Date()));
  });

  test("sell + down → isCorrect=1", async () => {
    const signalDate = new Date(Date.now() - 10 * 86_400_000);
    await insertSignal({ ticker: "AAPL", signal: "sell", role: "bear", daysAgo: 10 });
    await writer.syncPlaceholders();
    await insertMark("US", "AAPL", dateToTradingDay(signalDate, "US"), 100);
    const endDate = nextNTradingDays(signalDate, 5, "US");
    await insertMark("US", "AAPL", dateToTradingDay(endDate, "US"), 95);

    const r = await writer.evaluatePending();
    expect(r.evaluated).toBe(1);
    const db = await getDb();
    const row = await db.select().from(analystAccuracyLog).get();
    expect(row?.actualOutcome).toBe("down");
    expect(row?.isCorrect).toBe(1);
  });

  test("hold + flat → isCorrect=1", async () => {
    const signalDate = new Date(Date.now() - 10 * 86_400_000);
    await insertSignal({ ticker: "AAPL", signal: "hold", role: "neutral", daysAgo: 10 });
    await writer.syncPlaceholders();
    await insertMark("US", "AAPL", dateToTradingDay(signalDate, "US"), 100);
    const endDate = nextNTradingDays(signalDate, 5, "US");
    await insertMark("US", "AAPL", dateToTradingDay(endDate, "US"), 100.5); // +0.5% < 2%

    const r = await writer.evaluatePending();
    expect(r.evaluated).toBe(1);
    const db = await getDb();
    const row = await db.select().from(analystAccuracyLog).get();
    expect(row?.actualOutcome).toBe("flat");
    expect(row?.isCorrect).toBe(1);
  });

  test("buy + down → isCorrect=0", async () => {
    const signalDate = new Date(Date.now() - 10 * 86_400_000);
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 10 });
    await writer.syncPlaceholders();
    await insertMark("US", "AAPL", dateToTradingDay(signalDate, "US"), 100);
    const endDate = nextNTradingDays(signalDate, 5, "US");
    await insertMark("US", "AAPL", dateToTradingDay(endDate, "US"), 95);

    await writer.evaluatePending();
    const db = await getDb();
    const row = await db.select().from(analystAccuracyLog).get();
    expect(row?.isCorrect).toBe(0);
  });
});

describe("evaluatePending — 边界", () => {
  test("缺 start mark → skippedNoMark", async () => {
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 10 });
    await writer.syncPlaceholders();
    const r = await writer.evaluatePending();
    expect(r.skippedNoMark).toBe(1);
    expect(r.evaluated).toBe(0);
  });

  test("缺 end mark → skippedNoFutureMark", async () => {
    const signalDate = new Date(Date.now() - 10 * 86_400_000);
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 10 });
    await writer.syncPlaceholders();
    await insertMark("US", "AAPL", dateToTradingDay(signalDate, "US"), 100);
    // end mark 不插

    const r = await writer.evaluatePending();
    expect(r.skippedNoFutureMark).toBe(1);
    expect(r.evaluated).toBe(0);
  });

  test("signal 还在评估窗口内 → 不扫", async () => {
    await insertSignal({ ticker: "AAPL", signal: "buy", role: "bull", daysAgo: 2 });
    await writer.syncPlaceholders();
    const r = await writer.evaluatePending({ evalDelayDays: 5 });
    expect(r.scanned).toBe(0); // signalDate too recent
  });

  test("未知 ticker（如 XYZ123） → 走推断 → 不命中 → 跳过", async () => {
    await insertSignal({ ticker: "XYZ123", signal: "buy", role: "bull", daysAgo: 10 });
    await writer.syncPlaceholders();
    const r = await writer.evaluatePending({
      getMarketForTicker: () => null, // 强制 null 触发跳过
    });
    expect(r.skippedNoMark).toBe(1);
  });
});

describe("defaultTickerToMarket", () => {
  test.each([
    ["600000.SH", "CN"],
    ["600000.SS", "CN"],
    ["000001.SZ", "CN"],
    ["00700.HK", "HK"],
    ["AAPL", "US"],
    ["MSFT", "US"],
    ["BTC/USDT", "CRYPTO"],
    ["BTC-USD", "CRYPTO"],
    ["BTC", "CRYPTO"],
    ["random_thing", null],
    ["", null],
  ])("%s → %s", (ticker, expected) => {
    expect(defaultTickerToMarket(ticker)).toBe(expected);
  });
});

describe("computeIsCorrect", () => {
  test.each<["buy" | "sell" | "hold", "up" | "down" | "flat", boolean]>([
    ["buy", "up", true],
    ["buy", "down", false],
    ["buy", "flat", false],
    ["sell", "down", true],
    ["sell", "up", false],
    ["hold", "flat", true],
    ["hold", "up", false],
  ])("%s + %s → %s", (p, a, expected) => {
    expect(computeIsCorrect(p, a)).toBe(expected);
  });
});

describe("nextNTradingDays", () => {
  test("CN 跳 1 = 下一交易日", () => {
    const mon = new Date("2026-06-01T10:00:00Z"); // 周一
    const next = nextNTradingDays(mon, 1, "CN");
    expect(dateToTradingDay(next, "CN")).toBe("2026-06-02");
  });
  test("CN 跳 5 = 跨周末取下下周一", () => {
    const mon = new Date("2026-06-01T10:00:00Z"); // 周一
    const next = nextNTradingDays(mon, 5, "CN");
    // 1=Tue 6/2, 2=Wed 6/3, 3=Thu 6/4, 4=Fri 6/5, 5=Mon 6/8
    expect(dateToTradingDay(next, "CN")).toBe("2026-06-08");
  });
});
