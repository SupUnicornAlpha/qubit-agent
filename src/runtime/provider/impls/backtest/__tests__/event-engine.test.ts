import { describe, expect, test } from "bun:test";
import { type BarPoint, type EngineInput, runEventEngine } from "../event-engine";

function makeFlatBars(symbols: string[], dates: string[], prices: number[][]) {
  // prices[d][s] → close
  const bars = new Map<string, Map<string, BarPoint>>();
  for (let d = 0; d < dates.length; d++) {
    const m = new Map<string, BarPoint>();
    for (let s = 0; s < symbols.length; s++) {
      const px = prices[d]?.[s]!;
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
    signals.set(
      "2026-01-05",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-06",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-07",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );

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
    signals.set(
      "2026-01-28",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-29",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-30",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-02-02",
      new Map([
        ["A", 0],
        ["B", 1],
      ])
    );
    signals.set(
      "2026-02-03",
      new Map([
        ["A", 0],
        ["B", 1],
      ])
    );

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
    signals.set(
      "2026-01-05",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-06",
      new Map([
        ["A", 0],
        ["B", 1],
      ])
    );
    signals.set(
      "2026-01-07",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-08",
      new Map([
        ["A", 0],
        ["B", 1],
      ])
    );

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
    signals.set(
      "2026-01-05",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-06",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );
    signals.set(
      "2026-01-07",
      new Map([
        ["A", 1],
        ["B", 0],
      ])
    );

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

  test("longShort=true：同时持有多头与空头，空头收益应计入净值", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["A", "B"], dates, [
      [100, 100],
      [100, 100],
      [110, 90],
    ]);
    const signals = new Map(
      dates.map((date) => [
        date,
        new Map([
          ["A", 1],
          ["B", -1],
        ]),
      ])
    );
    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 1_000_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: true,
      reverse: false,
      topN: 1,
    });
    expect(r.trades.some((trade) => trade.symbol === "A" && trade.side === "buy")).toBe(true);
    expect(r.trades.some((trade) => trade.symbol === "B" && trade.side === "sell")).toBe(true);
    expect(r.equityCurve.at(-1)?.equity).toBeGreaterThan(1_090_000);
  });

  test("空信号会在下一根可交易 K 线平仓，不沿用过期 target", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    const bars = makeFlatBars(["A"], dates, [[100], [100], [100], [100]]);
    const signals = new Map<string, Map<string, number | null>>([
      [dates[0]!, new Map([["A", 1]])],
      [dates[1]!, new Map()],
      [dates[2]!, new Map()],
      [dates[3]!, new Map()],
    ]);
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
    expect(r.trades.map((trade) => trade.side)).toEqual(["buy", "sell"]);
  });

  test("缺失 K 线沿用最后可用标记估值，不会让已持仓市值消失", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07", "2026-01-08"];
    const bars = makeFlatBars(["A"], dates, [[100], [100], [100], [110]]);
    bars.set(dates[2]!, new Map()); // 暂停交易 / 行情缺失
    const signals = new Map(dates.map((date) => [date, new Map([["A", 1]])]));
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
    expect(r.equityCurve[2]?.equity).toBeCloseTo(1_000_000, 5);
    expect(r.equityCurve.at(-1)?.equity).toBeGreaterThan(1_090_000);
  });

  test("最低佣金纳入买入预算，不允许现金因手续费变成负数", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["A"], dates, [[100], [100], [100]]);
    const signals = new Map(dates.map((date) => [date, new Map([["A", 1]])]));
    const r = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100,
      costs: { commissionBps: 0, slippageBps: 0, minCommission: 1 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
      topN: 1,
    });
    expect(r.equityCurve.at(-1)?.equity).toBeGreaterThanOrEqual(99 - 1e-6);
    expect(r.equityCurve.at(-1)?.equity).toBeLessThanOrEqual(100 + 1e-6);
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

  test("欧式期权按合约乘数建仓，并在到期日按快照结算价现金结算", () => {
    const dates = ["2026-01-28", "2026-01-29", "2026-01-30"];
    const bars = makeFlatBars(["OPT"], dates, [[10], [10], [12]]);
    bars.get("2026-01-30")!.set("OPT", {
      open: 12,
      high: 15,
      low: 11,
      close: 12,
      volume: 1_000,
      settlementPrice: 15,
    });
    const signals = new Map(
      dates.map((date) => [date, new Map<string, number | null>([["OPT", 1]])])
    );
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
      instruments: {
        OPT: {
          assetClass: "option",
          contractMultiplier: 100,
          lotSize: 1,
          expiryDate: "2026-01-30",
          settlementMode: "cash",
          underlyingSymbol: "AAPL",
          strike: 200,
          optionRight: "call",
          exerciseStyle: "european",
        },
      },
    });

    expect(result.trades[0]?.qty).toBe(100);
    expect(result.trades.at(-1)?.price).toBe(15);
    expect(result.equityCurve.at(-1)?.equity).toBe(150_000);
  });

  test("期权在同快照标的、IV 与利率完整时记录 Black–Scholes Greeks", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["OPT", "AAPL"], dates, [
      [10, 100],
      [10, 101],
      [11, 102],
    ]);
    for (const bySymbol of bars.values()) {
      const option = bySymbol.get("OPT")!;
      option.impliedVolatility = 0.2;
      option.riskFreeRateAnnual = 0.04;
    }
    const signals = new Map(
      dates.map((date) => [date, new Map<string, number | null>([["OPT", 1]])])
    );
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "weekly",
      longShort: false,
      reverse: false,
      instruments: {
        OPT: {
          assetClass: "option",
          contractMultiplier: 100,
          lotSize: 1,
          expiryDate: "2026-06-19",
          settlementMode: "cash",
          underlyingSymbol: "AAPL",
          strike: 100,
          optionRight: "call",
          exerciseStyle: "european",
          pricingModel: "black_scholes",
        },
      },
    });

    const risk = result.meta.assetLifecycleEvents?.find(
      (event) => event.kind === "option_greeks_snapshot"
    );
    expect(risk?.optionRisk?.delta).toBeGreaterThan(0);
    expect(risk?.optionRisk?.gamma).toBeGreaterThan(0);
  });

  test("币永续从快照 Bar 逐期扣除正资金费", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["BTC-PERP"], dates, [[100], [100], [100]]);
    for (const bySymbol of bars.values()) {
      bySymbol.get("BTC-PERP")!.fundingRateBps = 10;
    }
    const signals = new Map(
      dates.map((date) => [date, new Map<string, number | null>([["BTC-PERP", 1]])])
    );
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "weekly",
      longShort: false,
      reverse: false,
      instruments: {
        "BTC-PERP": { assetClass: "crypto", contractKind: "perpetual" },
      },
    });

    expect(result.equityCurve.at(-1)?.equity).toBeCloseTo(99_800, 8);
  });

  test("期货逐日盯市：跌破维持保证金时从可用现金追保", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["ES"], dates, [[5_000], [5_000], [4_000]]);
    const signals = new Map(
      dates.map((date) => [date, new Map<string, number | null>([["ES", 1]])])
    );
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "weekly",
      longShort: false,
      reverse: false,
      instruments: {
        ES: {
          assetClass: "future",
          contractMultiplier: 50,
          lotSize: 1,
          expiryDate: "2026-03-20",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          targetLeverage: 3,
        },
      },
    });

    expect(result.trades[0]?.qty).toBe(1);
    expect(result.equityCurve.at(-1)?.equity).toBe(50_000);
    expect(
      result.meta.assetLifecycleEvents?.some((event) => event.kind === "futures_margin_call")
    ).toBe(true);
  });

  test("期货无法补足保证金时强平，并保留强平审计事件", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["ES"], dates, [[5_000], [5_000], [4_000]]);
    const signals = new Map(
      dates.map((date) => [date, new Map<string, number | null>([["ES", 1]])])
    );
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 30_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "weekly",
      longShort: false,
      reverse: false,
      instruments: {
        ES: {
          assetClass: "future",
          contractMultiplier: 50,
          lotSize: 1,
          expiryDate: "2026-03-20",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          targetLeverage: 10,
        },
      },
    });

    expect(
      result.meta.assetLifecycleEvents?.some((event) => event.kind === "futures_forced_liquidation")
    ).toBe(true);
    expect(result.trades.at(-1)?.price).toBe(4_000);
  });

  test("显式期货换月在冻结日期平旧开新，并保留换月事件", () => {
    const dates = ["2026-03-12", "2026-03-13", "2026-03-14"];
    const bars = makeFlatBars(["ESH6", "ESM6"], dates, [
      [5_000, 5_020],
      [5_000, 5_020],
      [5_100, 5_120],
    ]);
    const signals = new Map(
      dates.map((date) => [date, new Map<string, number | null>([["ESH6", 1]])])
    );
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
      instruments: {
        ESH6: {
          assetClass: "future",
          contractMultiplier: 50,
          lotSize: 1,
          expiryDate: "2026-03-20",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          targetLeverage: 3,
          futureRoll: { rollDate: "2026-03-14", successorSymbol: "ESM6" },
        },
        ESM6: {
          assetClass: "future",
          contractMultiplier: 50,
          lotSize: 1,
          expiryDate: "2026-06-19",
          settlementMode: "cash",
          initialMarginRate: 0.1,
          maintenanceMarginRate: 0.08,
          targetLeverage: 3,
        },
      },
    });

    expect(result.trades.map((trade) => `${trade.side}:${trade.symbol}`)).toEqual([
      "buy:ESH6",
      "sell:ESH6",
      "buy:ESM6",
    ]);
    expect(
      result.meta.assetLifecycleEvents?.some(
        (event) => event.kind === "futures_roll" && event.detail === "rolled:ESH6->ESM6"
      )
    ).toBe(true);
  });

  test("涨停买入保持未成交，并写入可成交性审计", () => {
    const dates = ["2026-01-05", "2026-01-06"];
    const bars = makeFlatBars(["A"], dates, [[10], [10]]);
    bars.get("2026-01-06")!.get("A")!.priceLimitUp = 10;
    const signals = new Map<string, Map<string, number | null>>([
      ["2026-01-05", new Map([["A", 1]])],
      ["2026-01-06", new Map([["A", 1]])],
    ]);
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
    });

    expect(result.trades).toEqual([]);
    expect(
      result.meta.assetLifecycleEvents?.some((event) => event.detail === "limit_up_buy_blocked")
    ).toBe(true);
  });

  test("跌停卖出保持原仓位，并写入可成交性审计", () => {
    const dates = ["2026-01-05", "2026-01-06", "2026-01-07"];
    const bars = makeFlatBars(["A"], dates, [[10], [10], [9]]);
    bars.get("2026-01-07")!.get("A")!.priceLimitDown = 9;
    const signals = new Map<string, Map<string, number | null>>([
      ["2026-01-05", new Map([["A", 1]])],
      ["2026-01-06", new Map()],
      ["2026-01-07", new Map()],
    ]);
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
    });

    expect(result.trades.filter((trade) => trade.side === "buy")).toHaveLength(1);
    expect(result.trades.filter((trade) => trade.side === "sell")).toHaveLength(0);
    expect(
      result.meta.assetLifecycleEvents?.some((event) => event.detail === "limit_down_sell_blocked")
    ).toBe(true);
  });

  test("冻结交易日历标记闭市时不撮合，并写入审计", () => {
    const dates = ["2026-01-05", "2026-01-06"];
    const bars = makeFlatBars(["A"], dates, [[10], [10]]);
    bars.get("2026-01-06")!.get("A")!.calendarSession = "closed";
    const signals = new Map<string, Map<string, number | null>>([
      ["2026-01-05", new Map([["A", 1]])],
      ["2026-01-06", new Map([["A", 1]])],
    ]);
    const result = runEventEngine({
      dates,
      bars,
      signals,
      capital: 100_000,
      costs: { commissionBps: 0, slippageBps: 0 },
      rebalance: "daily",
      longShort: false,
      reverse: false,
    });

    expect(result.trades).toEqual([]);
    expect(
      result.meta.assetLifecycleEvents?.some((event) => event.detail === "calendar_closed")
    ).toBe(true);
  });
});
