/**
 * P4b — pnl-calc 纯函数测试。
 *
 * 覆盖（详见 pnl-calc.ts 头部"已覆盖边界"）：
 *   1) 单 symbol 单日单 fill 多头建仓 + mark
 *   2) 多日持仓 mark 波动（unrealized 跟随）
 *   3) 部分平仓 realized
 *   4) 跨 0 反向（多→空）
 *   5) 跨 0 反向（空→多）
 *   6) mark 三级 fallback
 *   7) 增量从 priorPositions 起算
 *   8) 多 symbol + 同日多 fill 聚合
 *   9) feeProvider 介入（fill.fee=undefined）
 */

import { describe, expect, test } from "bun:test";
import { calcPnlSeries, type MarkPriceLookup, type PnlFill } from "../pnl-calc";

const mk =
  (data: Record<string, Record<string, number>>): MarkPriceLookup =>
  (symbol, day) => {
    const close = data[day]?.[symbol];
    if (close === undefined) return undefined;
    return { close, source: "test_fixture" };
  };

function f(p: Partial<PnlFill> & Pick<PnlFill, "symbol" | "side" | "qty" | "price" | "tradingDay" | "ts">): PnlFill {
  return {
    id: p.id ?? `${p.symbol}-${p.tradingDay}-${p.ts}-${p.side}-${p.qty}-${p.price}`,
    market: p.market ?? "US",
    assetClass: p.assetClass ?? "stock",
    broker: p.broker ?? "paper",
    ...p,
  };
}

describe("calcPnlSeries", () => {
  test("场景1：单 symbol 单日多头建仓 → unrealizedDaily 等于 (mark - cost)*qty", () => {
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 152 } }),
    });
    expect(r.snapshots).toHaveLength(1);
    const s = r.snapshots[0];
    if (!s) throw new Error("missing snapshot");
    expect(s.qty).toBe(100);
    expect(s.avgCost).toBe(150);
    expect(s.markPrice).toBe(152);
    expect(s.marketValue).toBe(15200);
    expect(s.realizedPnlDaily).toBe(0);
    expect(s.unrealizedPnlDaily).toBe(200);
    expect(s.unrealizedPnlCum).toBe(200);
  });

  test("场景2：多日持仓 mark 波动 → unrealizedDaily 按相邻日差值", () => {
    // 2026-06-01 buy 100@150；6-02 mark=152；6-03 mark=149
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-03",
      market: "US",
      priorPositions: [],
      markLookup: mk({
        "2026-06-01": { AAPL: 150 },
        "2026-06-02": { AAPL: 152 },
        "2026-06-03": { AAPL: 149 },
      }),
    });
    // 6-01 实际是周一；6-02 周二；6-03 周三；3 个交易日
    expect(r.snapshots).toHaveLength(3);
    const [d1, d2, d3] = r.snapshots;
    if (!d1 || !d2 || !d3) throw new Error("missing snapshot");
    // Day1：mark=150 == cost，unrealized=0
    expect(d1.unrealizedPnlCum).toBe(0);
    // Day2：mark=152 vs cost=150 → cumU=200，dailyU=200-0=200
    expect(d2.unrealizedPnlCum).toBe(200);
    expect(d2.unrealizedPnlDaily).toBe(200);
    // Day3：mark=149 vs cost=150 → cumU=-100，dailyU=-100-200=-300
    expect(d3.unrealizedPnlCum).toBe(-100);
    expect(d3.unrealizedPnlDaily).toBe(-300);
  });

  test("场景3：部分平仓 realizedDaily 按 (sell_price - avg_cost) * sold", () => {
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
      f({ symbol: "AAPL", side: "sell", qty: 40, price: 155, tradingDay: "2026-06-02", ts: "2026-06-02T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-02",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 150 }, "2026-06-02": { AAPL: 156 } }),
    });
    const d2 = r.snapshots.find((s) => s.tradingDay === "2026-06-02");
    if (!d2) throw new Error("missing d2");
    // realized = (155-150)*40 = 200
    expect(d2.realizedPnlDaily).toBe(200);
    expect(d2.realizedPnlCum).toBe(200);
    // 剩仓 60；avgCost 仍 150；mark=156 → unrealizedCum = 60*6 = 360
    expect(d2.qty).toBe(60);
    expect(d2.avgCost).toBe(150);
    expect(d2.unrealizedPnlCum).toBe(360);
  });

  test("场景4：多→空跨 0 反向", () => {
    // buy 100@150 → sell 150@160 → 应留下空头 50，avgCost=160；realized = (160-150)*100 = 1000
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
      f({ symbol: "AAPL", side: "sell", qty: 150, price: 160, tradingDay: "2026-06-02", ts: "2026-06-02T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-02",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 150 }, "2026-06-02": { AAPL: 161 } }),
    });
    const d2 = r.snapshots.find((s) => s.tradingDay === "2026-06-02");
    if (!d2) throw new Error("missing d2");
    expect(d2.realizedPnlDaily).toBe(1000);
    expect(d2.qty).toBe(-50);
    expect(d2.avgCost).toBe(160);
    // 空头 unrealizedCum = qty * (mark - cost) = -50 * (161-160) = -50
    expect(d2.unrealizedPnlCum).toBe(-50);
  });

  test("场景5：空→多跨 0 反向", () => {
    // sell 100@160 → buy 150@155 → 应留下多头 50@155；realized = (160-155)*100 = 500
    const fills = [
      f({ symbol: "AAPL", side: "sell", qty: 100, price: 160, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
      f({ symbol: "AAPL", side: "buy", qty: 150, price: 155, tradingDay: "2026-06-02", ts: "2026-06-02T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-02",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 160 }, "2026-06-02": { AAPL: 156 } }),
    });
    const d2 = r.snapshots.find((s) => s.tradingDay === "2026-06-02");
    if (!d2) throw new Error("missing d2");
    expect(d2.realizedPnlDaily).toBe(500);
    expect(d2.qty).toBe(50);
    expect(d2.avgCost).toBe(155);
    expect(d2.unrealizedPnlCum).toBe(50); // 50 * (156-155)
  });

  test("场景6：mark 三级 fallback", () => {
    // Day1 拿到 mark=150；Day2 缺 mark → fallback_prev_day=150；Day3 仍缺 → 还是 150
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-03",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 150 } }),
    });
    expect(r.snapshots).toHaveLength(3);
    expect(r.snapshots[0]?.markSource).toBe("test_fixture");
    expect(r.snapshots[1]?.markSource).toBe("fallback_prev_day");
    expect(r.snapshots[1]?.markPrice).toBe(150);
    expect(r.snapshots[2]?.markSource).toBe("fallback_prev_day");
  });

  test("场景6b：完全没 mark + 仅 priorPositions → fallback_avg_cost", () => {
    const r = calcPnlSeries({
      fills: [],
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      market: "US",
      priorPositions: [{ symbol: "AAPL", qty: 100, avgCost: 150, realizedCum: 0, feeCum: 0 }],
      markLookup: mk({}),
    });
    expect(r.snapshots).toHaveLength(1);
    const s = r.snapshots[0];
    if (!s) throw new Error("missing");
    expect(s.markSource).toBe("fallback_avg_cost");
    expect(s.markPrice).toBe(150);
    expect(s.unrealizedPnlCum).toBe(0); // mark == cost
  });

  test("场景7：增量从 priorPositions 起算", () => {
    // prior：100 股 AAPL @ 150；今日 sell 30 @ 160；mark 161
    const fills = [
      f({ symbol: "AAPL", side: "sell", qty: 30, price: 160, tradingDay: "2026-06-03", ts: "2026-06-03T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-03",
      toDay: "2026-06-03",
      market: "US",
      priorPositions: [{ symbol: "AAPL", qty: 100, avgCost: 150, realizedCum: 500, feeCum: 2 }],
      markLookup: mk({ "2026-06-03": { AAPL: 161 } }),
    });
    const s = r.snapshots[0];
    if (!s) throw new Error("missing");
    expect(s.realizedPnlDaily).toBe(300); // (160-150)*30
    expect(s.realizedPnlCum).toBe(800); // 500 + 300
    expect(s.qty).toBe(70);
    expect(s.feeCum).toBe(2); // 没有 feeProvider 也没 fill.fee → 2 不变
  });

  test("场景8：多 symbol + 同日多 fill 聚合到 1 行/symbol", () => {
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
      f({ symbol: "AAPL", side: "buy", qty: 50, price: 152, tradingDay: "2026-06-01", ts: "2026-06-01T13:35:00Z" }),
      f({ symbol: "MSFT", side: "buy", qty: 20, price: 400, tradingDay: "2026-06-01", ts: "2026-06-01T13:31:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 153, MSFT: 405 } }),
    });
    expect(r.snapshots).toHaveLength(2);
    const aapl = r.snapshots.find((s) => s.symbol === "AAPL");
    const msft = r.snapshots.find((s) => s.symbol === "MSFT");
    if (!aapl || !msft) throw new Error("missing");
    expect(aapl.qty).toBe(150);
    // avgCost = (100*150 + 50*152)/150 = (15000+7600)/150 = 150.6666...
    expect(aapl.avgCost).toBeCloseTo(150.6667, 4);
    expect(aapl.fillCount).toBe(2);
    expect(msft.qty).toBe(20);
    expect(msft.fillCount).toBe(1);
  });

  test("场景9：feeProvider 注入（fill.fee=undefined）", () => {
    const fills = [
      f({ symbol: "AAPL", side: "buy", qty: 100, price: 150, tradingDay: "2026-06-01", ts: "2026-06-01T13:30:00Z" }),
    ];
    const r = calcPnlSeries({
      fills,
      fromDay: "2026-06-01",
      toDay: "2026-06-01",
      market: "US",
      priorPositions: [],
      markLookup: mk({ "2026-06-01": { AAPL: 150 } }),
      feeProvider: () => 1.99,
    });
    const s = r.snapshots[0];
    if (!s) throw new Error("missing");
    expect(s.feeDaily).toBe(1.99);
    expect(s.feeCum).toBe(1.99);
    expect(s.turnoverDaily).toBe(15000);
  });

  test("场景10：空 fills 且空 priorPositions → 无 snapshot", () => {
    const r = calcPnlSeries({
      fills: [],
      fromDay: "2026-06-01",
      toDay: "2026-06-03",
      market: "US",
      priorPositions: [],
      markLookup: mk({}),
    });
    expect(r.snapshots).toHaveLength(0);
    expect(r.finalPositions).toHaveLength(0);
  });
});
