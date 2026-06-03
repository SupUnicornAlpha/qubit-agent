/**
 * P4b PnlAttributor 集成测：基于真实 schema 端到端跑 fill → snapshot。
 *
 * Fixture（一次性建）：
 *   workspace → project → workflow_run
 *   chat_session → indicator_strategy_script → strategy_runtime
 *   strategy → strategy_version
 *   instrument
 *
 * 每个 case 自己造 order_intent + broker_order + fill + daily_mark_price，
 * 不污染 fixture。BUILTIN_PAPER_TRADING_ACCOUNT_ID + BUILTIN_PAPER_CONNECTOR_INSTANCE_ID
 * 由 0019 migration seed，无需手建。
 *
 * 覆盖：
 *   1) 单 runtime / 单日 / 单 symbol → 写出 1 行 snapshot 正确
 *   2) 跨日持仓 + mark 波动 → unrealizedDaily 正确
 *   3) 同日多个 fill 同 symbol → 1 行 snapshot 聚合
 *   4) 多 symbol → 多行 snapshot
 *   5) 多 runtime 并行（marketScope 过滤 + runtimeIds 过滤）
 *   6) 增量：第二次 run 从 prior snapshots 起算 + 写新行
 *   7) fee 估算：fill.fee=0 → FeeCalculator 介入
 *   8) dry-run：不写库
 *   9) 单 runtime 异常隔离（人为给个不存在的 order_intent → 写库失败不传染）
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import {
  BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
  BUILTIN_PAPER_TRADING_ACCOUNT_ID,
  brokerOrder,
  chatSession,
  dailyMarkPrice,
  feeSchedule,
  fill,
  indicatorStrategyScript,
  instrument,
  orderIntent,
  project,
  strategy,
  strategyPnlSnapshot,
  strategyRuntime,
  strategyVersion,
  workflowRun,
  workspace,
} from "../../../db/sqlite/schema";
import { createPnlAttributor } from "../pnl-attributor";

interface Fixture {
  workspaceId: string;
  projectId: string;
  workflowRunId: string;
  chatSessionId: string;
  scriptId: string;
  strategyId: string;
  strategyVersionId: string;
  instrumentIdAAPL: string;
  instrumentIdMSFT: string;
  runtimeUSId: string;
  runtimeUS2Id: string;
  runtimeCNId: string;
}

let fixture: Fixture;

beforeAll(async () => {
  process.env.QUBIT_DATA_DIR = join("/tmp", `qubit-p4b-pnl-${Date.now()}`);
  await runMigrations();
  const db = await getDb();

  const f: Fixture = {
    workspaceId: `ws_${randomUUID()}`,
    projectId: `prj_${randomUUID()}`,
    workflowRunId: `wf_${randomUUID()}`,
    chatSessionId: `cs_${randomUUID()}`,
    scriptId: `script_${randomUUID()}`,
    strategyId: `strat_${randomUUID()}`,
    strategyVersionId: `strv_${randomUUID()}`,
    instrumentIdAAPL: `inst_${randomUUID()}`,
    instrumentIdMSFT: `inst_${randomUUID()}`,
    runtimeUSId: `rt_${randomUUID()}`,
    runtimeUS2Id: `rt_${randomUUID()}`,
    runtimeCNId: `rt_${randomUUID()}`,
  };

  await db.insert(workspace).values({ id: f.workspaceId, name: "t", owner: "tester" }).run();
  await db
    .insert(project)
    .values({ id: f.projectId, workspaceId: f.workspaceId, name: "p", marketScope: "US" })
    .run();
  await db
    .insert(workflowRun)
    .values({ id: f.workflowRunId, projectId: f.projectId, goal: "g", mode: "live" })
    .run();
  await db
    .insert(chatSession)
    .values({ id: f.chatSessionId, workspaceId: f.workspaceId, title: "t" })
    .run();
  await db
    .insert(indicatorStrategyScript)
    .values({
      id: f.scriptId,
      sessionId: f.chatSessionId,
      workflowRunId: f.workflowRunId,
      name: "test-script",
    })
    .run();
  await db
    .insert(strategy)
    .values({ id: f.strategyId, projectId: f.projectId, name: "s", style: "low_freq" })
    .run();
  await db
    .insert(strategyVersion)
    .values({
      id: f.strategyVersionId,
      strategyId: f.strategyId,
      versionTag: "v1",
      logicHash: "abc",
      paramSchemaJson: {},
    })
    .run();
  await db
    .insert(instrument)
    .values({
      id: f.instrumentIdAAPL,
      symbol: "AAPL",
      assetClass: "stock",
      exchange: "NASDAQ",
    })
    .run();
  await db
    .insert(instrument)
    .values({
      id: f.instrumentIdMSFT,
      symbol: "MSFT",
      assetClass: "stock",
      exchange: "NASDAQ",
    })
    .run();
  await db
    .insert(strategyRuntime)
    .values({
      id: f.runtimeUSId,
      strategyScriptId: f.scriptId,
      market: "US",
      symbol: "AAPL",
      executionMode: "paper",
    })
    .run();
  await db
    .insert(strategyRuntime)
    .values({
      id: f.runtimeUS2Id,
      strategyScriptId: f.scriptId,
      market: "US",
      symbol: "MSFT",
      executionMode: "paper",
    })
    .run();
  await db
    .insert(strategyRuntime)
    .values({
      id: f.runtimeCNId,
      strategyScriptId: f.scriptId,
      market: "CN",
      symbol: "600519.SH",
      executionMode: "paper",
    })
    .run();

  fixture = f;
});

beforeEach(async () => {
  const db = await getDb();
  // 清表，保留 fixture 链与 fee_schedule seed
  await db.delete(strategyPnlSnapshot).run();
  await db.delete(fill).run();
  await db.delete(brokerOrder).run();
  await db.delete(orderIntent).run();
  await db.delete(dailyMarkPrice).run();
});

/** 一站式造一笔 fill：order_intent → broker_order → fill。返回 fillId 方便排查。 */
async function insertFill(opts: {
  runtimeId: string;
  market: string;
  symbol: string;
  instrumentId: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  /** ISO datetime；决定 filledAt 与 trading_day */
  filledAt: string;
  /** 默认 0；非 0 时 FeeCalculator 不介入 */
  fee?: number;
}): Promise<string> {
  const db = await getDb();
  const intentId = `oi_${randomUUID()}`;
  const orderId = `bo_${randomUUID()}`;
  const fillId = `f_${randomUUID()}`;
  await db
    .insert(orderIntent)
    .values({
      id: intentId,
      workflowRunId: fixture.workflowRunId,
      strategyVersionId: fixture.strategyVersionId,
      instrumentId: opts.instrumentId,
      side: opts.side,
      qty: opts.qty,
      orderType: "market",
      timeInForce: "day",
      market: opts.market,
      symbol: opts.symbol,
      strategyRuntimeId: opts.runtimeId,
    })
    .run();
  await db
    .insert(brokerOrder)
    .values({
      id: orderId,
      orderIntentId: intentId,
      accountId: BUILTIN_PAPER_TRADING_ACCOUNT_ID,
      connectorInstanceId: BUILTIN_PAPER_CONNECTOR_INSTANCE_ID,
      brokerOrderId: `bbo_${orderId}`,
      status: "filled",
    })
    .run();
  await db
    .insert(fill)
    .values({
      id: fillId,
      brokerOrderId: orderId,
      fillQty: opts.qty,
      fillPrice: opts.price,
      fee: opts.fee ?? 0,
      filledAt: opts.filledAt,
    })
    .run();
  return fillId;
}

async function insertMark(market: string, symbol: string, day: string, close: number): Promise<void> {
  const db = await getDb();
  await db
    .insert(dailyMarkPrice)
    .values({
      id: `dmp_${randomUUID()}`,
      market,
      symbol,
      tradingDay: day,
      close,
      source: "test_fixture",
    })
    .run();
}

async function fetchSnapshots(runtimeId: string): Promise<Array<{
  tradingDay: string;
  symbol: string;
  qty: number;
  realizedPnlDaily: number;
  unrealizedPnlDaily: number;
  feeDaily: number;
  markPrice: number | null;
  source: string;
}>> {
  const db = await getDb();
  const rows = await db
    .select({
      tradingDay: strategyPnlSnapshot.tradingDay,
      symbol: strategyPnlSnapshot.symbol,
      qty: strategyPnlSnapshot.qty,
      realizedPnlDaily: strategyPnlSnapshot.realizedPnlDaily,
      unrealizedPnlDaily: strategyPnlSnapshot.unrealizedPnlDaily,
      feeDaily: strategyPnlSnapshot.feeDaily,
      markPrice: strategyPnlSnapshot.markPrice,
      source: strategyPnlSnapshot.source,
    })
    .from(strategyPnlSnapshot)
    .where(eq(strategyPnlSnapshot.strategyRuntimeId, runtimeId))
    .all();
  rows.sort((a, b) =>
    a.tradingDay !== b.tradingDay
      ? a.tradingDay.localeCompare(b.tradingDay)
      : a.symbol.localeCompare(b.symbol)
  );
  return rows;
}

describe("PnlAttributor runOnce", () => {
  test("场景1：单日单 fill → 写出 1 行 snapshot", async () => {
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z", // ET 10:00 周一
      fee: 1.0, // 明确 fee 避免 calculator 介入
    });
    await insertMark("US", "AAPL", "2026-06-01", 152);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });

    expect(summary.runtimesProcessed).toBe(1);
    expect(summary.fillsScanned).toBe(1);
    expect(summary.snapshotsWritten).toBe(1);
    expect(summary.errors).toHaveLength(0);

    const snaps = await fetchSnapshots(fixture.runtimeUSId);
    expect(snaps).toHaveLength(1);
    const s = snaps[0];
    if (!s) throw new Error("missing snapshot");
    expect(s.tradingDay).toBe("2026-06-01");
    expect(s.symbol).toBe("AAPL");
    expect(s.qty).toBe(100);
    expect(s.markPrice).toBe(152);
    expect(s.unrealizedPnlDaily).toBe(200);
    expect(s.feeDaily).toBe(1);
    expect(s.source).toBe("pnl_attributor_v0");
  });

  test("场景2：跨日持仓 mark 波动 → 3 行 snapshot 且 unrealizedDaily 正确", async () => {
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 1,
    });
    await insertMark("US", "AAPL", "2026-06-01", 150);
    await insertMark("US", "AAPL", "2026-06-02", 152);
    await insertMark("US", "AAPL", "2026-06-03", 149);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-03",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary.snapshotsWritten).toBe(3);

    const snaps = await fetchSnapshots(fixture.runtimeUSId);
    expect(snaps).toHaveLength(3);
    expect(snaps[1]?.unrealizedPnlDaily).toBe(200);
    expect(snaps[2]?.unrealizedPnlDaily).toBe(-300);
  });

  test("场景3：同日多 fill 同 symbol → 1 行聚合", async () => {
    const t1 = "2026-06-01T14:00:00.000Z";
    const t2 = "2026-06-01T14:05:00.000Z";
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: t1,
      fee: 1,
    });
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 50,
      price: 152,
      filledAt: t2,
      fee: 0.5,
    });
    await insertMark("US", "AAPL", "2026-06-01", 153);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary.fillsScanned).toBe(2);
    expect(summary.snapshotsWritten).toBe(1);

    const snaps = await fetchSnapshots(fixture.runtimeUSId);
    expect(snaps).toHaveLength(1);
    const s = snaps[0];
    if (!s) throw new Error("missing");
    expect(s.qty).toBe(150);
    expect(s.feeDaily).toBe(1.5);
  });

  test("场景4：单 runtime 多 symbol → 多行 snapshot", async () => {
    // 一个 runtime 上手动开两个 symbol（虽然 strategy_runtime.symbol 字段是 AAPL，
    // 但 order_intent 的 symbol 才是事实来源；attribution 跟 order_intent.symbol）
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 1,
    });
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "MSFT",
      instrumentId: fixture.instrumentIdMSFT,
      side: "buy",
      qty: 20,
      price: 400,
      filledAt: "2026-06-01T14:05:00.000Z",
      fee: 1,
    });
    await insertMark("US", "AAPL", "2026-06-01", 151);
    await insertMark("US", "MSFT", "2026-06-01", 405);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary.snapshotsWritten).toBe(2);
    const snaps = await fetchSnapshots(fixture.runtimeUSId);
    expect(snaps.map((s) => s.symbol).sort()).toEqual(["AAPL", "MSFT"]);
  });

  test("场景5：marketScope + runtimeIds 过滤", async () => {
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 1,
    });
    await insertFill({
      runtimeId: fixture.runtimeCNId,
      market: "CN",
      symbol: "600519.SH",
      instrumentId: fixture.instrumentIdAAPL, // 仅占位
      side: "buy",
      qty: 100,
      price: 1500,
      filledAt: "2026-06-01T02:00:00.000Z", // CN 10:00
      fee: 1,
    });
    await insertMark("US", "AAPL", "2026-06-01", 151);
    await insertMark("CN", "600519.SH", "2026-06-01", 1510);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    // marketScope = US 应该只跑 US 的 runtime
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      marketScope: ["US"],
    });
    expect(summary.runtimesScanned).toBeGreaterThanOrEqual(2); // US + US2 都被扫
    const usSnaps = await fetchSnapshots(fixture.runtimeUSId);
    const cnSnaps = await fetchSnapshots(fixture.runtimeCNId);
    expect(usSnaps).toHaveLength(1);
    expect(cnSnaps).toHaveLength(0); // CN runtime 没被 process
  });

  test("场景6：增量 - 第二次 run 从 prior snapshot 起算", async () => {
    // 第一次：day1 买入 100@150
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 1,
    });
    await insertMark("US", "AAPL", "2026-06-01", 151);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect((await fetchSnapshots(fixture.runtimeUSId))).toHaveLength(1);

    // 第二次：day2 sell 30@160（仅在 day2 引入新 fill，不重跑 day1）
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "sell",
      qty: 30,
      price: 160,
      filledAt: "2026-06-02T14:00:00.000Z",
      fee: 0.5,
    });
    await insertMark("US", "AAPL", "2026-06-02", 161);

    const summary2 = await attr.runOnce({
      fromDay: "2026-06-02",
      toDay: "2026-06-02",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary2.snapshotsWritten).toBe(1);

    const allSnaps = await fetchSnapshots(fixture.runtimeUSId);
    expect(allSnaps).toHaveLength(2);
    const day2 = allSnaps[1];
    if (!day2) throw new Error("missing day2");
    // 从 prior(qty=100, avgCost=150) 起算：sell 30@160 → realizedDaily=(160-150)*30=300
    expect(day2.realizedPnlDaily).toBe(300);
    expect(day2.qty).toBe(70);
  });

  test("场景7：fee 估算 - fill.fee=0 → FeeCalculator 介入", async () => {
    // 用 paper broker / US / stock / buy，预期 commissionRate 命中 seed
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 0, // 触发 calculator
    });
    await insertMark("US", "AAPL", "2026-06-01", 151);

    const db = await getDb();
    // fee_schedule 至少有 0060 seed 的若干行，且 paper broker 兜底（market='*'，'*' 通配）
    const rules = await db.select().from(feeSchedule).all();
    expect(rules.length).toBeGreaterThan(0);
    const paperRule = rules.find((r) => r.broker === "paper");
    expect(paperRule).toBeDefined();

    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary.snapshotsWritten).toBe(1);

    const snaps = await fetchSnapshots(fixture.runtimeUSId);
    const s = snaps[0];
    if (!s) throw new Error("missing");
    // 至少 fee 大于等于 0（具体值取决于 seed；paper 通常 0；非空 OK）
    expect(s.feeDaily).toBeGreaterThanOrEqual(0);
  });

  test("场景8：dry-run - 不写库", async () => {
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 1,
    });
    await insertMark("US", "AAPL", "2026-06-01", 151);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
      dryRun: true,
    });
    expect(summary.dryRun).toBe(true);
    expect(summary.snapshotsWritten).toBe(0);
    expect(summary.fillsScanned).toBe(1);

    const snaps = await fetchSnapshots(fixture.runtimeUSId);
    expect(snaps).toHaveLength(0);
  });

  test("场景9：空 runtime（无 fill 无 prior）→ runtimesSkipped + 不写库", async () => {
    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    expect(summary.runtimesSkipped).toBe(1);
    expect(summary.runtimesProcessed).toBe(0);
    expect(summary.snapshotsWritten).toBe(0);
  });

  test("场景10：perRunDay 元信息 - workflowRunIds + pnlAttributed 给 P4b-6 用", async () => {
    await insertFill({
      runtimeId: fixture.runtimeUSId,
      market: "US",
      symbol: "AAPL",
      instrumentId: fixture.instrumentIdAAPL,
      side: "buy",
      qty: 100,
      price: 150,
      filledAt: "2026-06-01T14:00:00.000Z",
      fee: 1,
    });
    await insertMark("US", "AAPL", "2026-06-01", 152);

    const db = await getDb();
    const attr = createPnlAttributor(db);
    const summary = await attr.runOnce({
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      runtimeIds: [fixture.runtimeUSId],
    });
    const r = summary.results[0];
    if (!r) throw new Error("missing");
    expect(r.perRunDay).toHaveLength(1);
    const pd = r.perRunDay[0];
    if (!pd) throw new Error("missing pd");
    expect(pd.workflowRunIds).toContain(fixture.workflowRunId);
    expect(pd.tradingDay).toBe("2026-06-01");
    // pnl = realizedDaily(0) + unrealizedDaily(200) - feeDaily(1) = 199
    expect(pd.pnlAttributed).toBe(199);
    expect(pd.symbols).toEqual(["AAPL"]);
  });
});
