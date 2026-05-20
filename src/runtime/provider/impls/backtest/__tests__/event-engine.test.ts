import { describe, expect, test } from "bun:test";
import { runEventEngine, type BarPoint, type EngineInput } from "../event-engine";

function makeFlatBars(symbols: string[], dates: string[], prices: number[][]) {
  // prices[d][s] → close
  const bars = new Map<string, Map<string, BarPoint>>();
  for (let d = 0; d < dates.length; d++) {
    const m = new Map<string, BarPoint>();
    for (let s = 0; s < symbols.length; s++) {
      const px = prices[d]![s]!;
      m.set(symbols[s]!, { open: px, high: px * 1.01, low: px * 0.99, close: px, volume: 1000 });
    }
    bars.set(dates[d]!, m);
  }
  return bars;
}

describe("EventEngine — 横截面 topN", () => {
  test("无信号 → 全程 flat，turnover=0", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const symbols = ["A", "B"];
    const bars = makeFlatBars(symbols, dates, [
      [100, 100],
      [101, 99],
      [102, 98],
    ]);
    const input: EngineInput = {
      dates,
      bars,
      signals: new Map(), // 空信号
      capital: 1_000_000,
      costs: { commissionBps: 5, slippageBps: 5 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
    };
    const r = runEventEngine(input);
    expect(r.equityCurve.length).toBe(3);
    expect(r.equityCurve[r.equityCurve.length - 1]?.equity).toBe(1_000_000);
    expect(r.trades.length).toBe(0);
    expect(r.meta.skippedDays).toBe(3);
  });

  test("最简策略：所有股都买入持有 → equity 跟随上涨", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    const symbols = ["A"];
    const bars = makeFlatBars(symbols, dates, [[100], [105], [110], [120]]);
    // 每天信号都是 1.0（满分）
    const signals = new Map<string, Map<string, number | null>>();
    for (const d of dates) signals.set(d, new Map([["A", 1.0]]));

    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
    });
    // 第二天 open=105 全仓建仓，到 day3 close=110 → 持仓市值 ~1_000_000*(110/105)
    expect(r.trades.length).toBeGreaterThan(0);
    const last = r.equityCurve[r.equityCurve.length - 1]!;
    expect(last.equity).toBeGreaterThan(1_000_000);
  });

  test("topN=1：从 2 个 symbol 中选高分", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const symbols = ["A", "B"];
    const bars = makeFlatBars(symbols, dates, [
      [100, 100],
      [101, 99],
      [102, 98],
    ]);
    const signals = new Map<string, Map<string, number | null>>();
    // day1 选 A
    signals.set("2026-01-05", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-06", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-07", new Map([["A", 1], ["B", 0]]));

    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
      topN: 1,
    });
    // 只 trade 了 A
    const tradedSymbols = new Set(r.trades.map((t) => t.symbol));
    expect(tradedSymbols.has("A")).toBe(true);
    expect(tradedSymbols.has("B")).toBe(false);
    // A 涨 → equity > 起始
    const last = r.equityCurve[r.equityCurve.length - 1]!;
    expect(last.equity).toBeGreaterThan(1_000_000);
  });

  test("monthly 再平衡：跨月才换仓", () => {
    const dates = [
      "2026-01-28",
      "2026-01-29",
      "2026-01-30",
      "2026-02-02", // 跨月
      "2026-02-03",
    ];
    const symbols = ["A", "B"];
    const bars = makeFlatBars(symbols, dates, [
      [100, 100],
      [100, 100],
      [100, 100],
      [100, 100],
      [100, 100],
    ]);
    const signals = new Map<string, Map<string, number | null>>();
    // 1 月信号是 A，2 月信号变 B
    signals.set("2026-01-28", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-29", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-30", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-02-02", new Map([["A", 0], ["B", 1]]));
    signals.set("2026-02-03", new Map([["A", 0], ["B", 1]]));

    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "monthly",
      longShort: false,
      reverse: false,
      topN: 1,
    });
    // 应当只在月初触发一次买入 A，第二个月初换到 B
    const buys = r.trades.filter((t) => t.side === "buy");
    expect(buys.length).toBe(2); // A 一次, B 一次
    expect(buys[0]?.symbol).toBe("A");
    expect(buys[1]?.symbol).toBe("B");
  });

  test("手续费 + 滑点：高换手能侵蚀收益", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    const symbols = ["A", "B"];
    const bars = makeFlatBars(symbols, dates, [
      [100, 100],
      [100, 100],
      [100, 100],
      [100, 100],
    ]);
    const signals = new Map<string, Map<string, number | null>>();
    // 每天来回切：A, B, A, B
    signals.set("2026-01-05", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-06", new Map([["A", 0], ["B", 1]]));
    signals.set("2026-01-07", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-08", new Map([["A", 0], ["B", 1]]));

    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 50, slippageBps: 50 }, // 100bp 单边 → 来回 200bp
      rebalance: "daily",
      longShort: false,
      reverse: false,
      topN: 1,
    });
    // 价格全部 flat 但手续费 + 滑点必然亏损
    const last = r.equityCurve[r.equityCurve.length - 1]!;
    expect(last.equity).toBeLessThan(1_000_000);
    expect(r.metrics.tradeCount).toBeGreaterThan(0);
  });

  test("reverse=true：因子值越小越好", () => {
    // day0 信号 → day1 open 撮合 → day2 close 估值
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const symbols = ["A", "B"];
    const bars = makeFlatBars(symbols, dates, [
      [100, 100],
      [100, 100], // 撮合日：A 与 B open 都是 100
      [120, 80], // 撮合后：A 涨 20%，B 跌 20%
    ]);
    const signals = new Map<string, Map<string, number | null>>();
    // 正向：A 分高 → reverse 后选 B
    signals.set("2026-01-05", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-06", new Map([["A", 1], ["B", 0]]));
    signals.set("2026-01-07", new Map([["A", 1], ["B", 0]]));

    const rRev = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: true,
      topN: 1,
    });
    const last = rRev.equityCurve[rRev.equityCurve.length - 1]!;
    // reverse → 选 B → 跌 20%
    expect(last.equity).toBeLessThan(900_000);
  });

  test("metrics 计算合理性", () => {
    const dates = Array.from({ length: 30 }, (_, i) => {
      const d = new Date("2026-01-01T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    const symbols = ["A"];
    const prices = dates.map((_, i) => [100 + i * 0.5]); // 缓涨
    const bars = makeFlatBars(symbols, dates, prices);
    const signals = new Map<string, Map<string, number | null>>();
    for (const d of dates) signals.set(d, new Map([["A", 1]]));

    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
    });
    expect(r.metrics.totalReturn).toBeGreaterThan(0);
    expect(r.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(r.metrics.tradeCount).toBeGreaterThan(0);
  });
});
