import { describe, expect, test } from "bun:test";
import {
  backtestStrategyContract,
  compileStrategyContract,
  instrumentIdToKlinesSymbol,
} from "../contract-service";

const GOOD = `
# @param period int 5 MA period range=2:50:1
# @param target_pct float 0.95 Target weight range=0.1:1.0:0.05

def initialize(context):
    g.symbol = "US:TEST"
    context.set_universe([g.symbol])
    context.subscribe(frequency="1d", fields=["open", "high", "low", "close", "volume"])
    context.set_warmup(3)
    context.set_benchmark("US:TEST")

def handle_data(context, data):
    period = int(context.params["period"])
    bars = get_history(period + 1, "1d", "close", g.symbol)
    if len(bars) < period:
        return
    price = float(bars["close"].iloc[-1])
    ma = float(bars["close"].tail(period).mean())
    pos = get_position(g.symbol)
    desired = float(context.params["target_pct"]) if price > ma else 0.0
    if desired > 0 and pos.amount <= 0:
        order_target_percent(g.symbol, desired, reason="ma_entry")
    elif desired == 0 and pos.amount > 0:
        order_target_percent(g.symbol, 0.0, reason="ma_exit")
`;

const BAD_INIT = `
def initialize(context):
    context.set_universe(["US:TEST"])
    get_history(10, "1d", "close", "US:TEST")

def handle_data(context, data):
    pass
`;

describe("strategy contract v2", () => {
  test("compile accepts valid Strategy API script", async () => {
    const r = await compileStrategyContract(GOOD);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.apiVersion).toBe(2);
    expect(r.manifest.strategyType).toBe("cta");
    expect(r.manifest.universe.instruments[0]?.instrumentId).toBe("US:TEST");
    expect(r.manifest.handlers).toContain("handle_data");
    expect(r.manifest.paramsSchema.some((p) => p.name === "period")).toBe(true);
  });

  test("compile rejects get_history inside initialize", async () => {
    const r = await compileStrategyContract(BAD_INIT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.toLowerCase()).toContain("initialize");
  });

  test("backtest runs synthetic bars and produces equity", async () => {
    const bars = Array.from({ length: 40 }, (_, i) => {
      const close = 100 + i * 0.5 + (i % 5 === 0 ? -2 : 0);
      return {
        symbol: "TEST",
        exchange: "US",
        timestamp: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
        open: close - 0.2,
        high: close + 0.5,
        low: close - 0.5,
        close,
        volume: 1000,
        turnover: 0,
      };
    });
    const r = await backtestStrategyContract({
      strategyCode: GOOD,
      bars,
      symbol: "US:TEST",
      initialCapital: 100_000,
      commission: 0.001,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.equityCurve.length).toBeGreaterThan(10);
    expect(Number.isFinite(r.metrics.totalReturnPct)).toBe(true);
    expect(r.manifest.codeHash.length).toBe(64);
    // The final-bar target is intentionally pending under next-open backtest
    // semantics; persistent sandbox runtimes consume this exact instruction.
    expect(Array.isArray(r.pendingIntents)).toBe(true);
  });

  test("backtest exposes latest pending contract target for a persistent runtime", async () => {
    const code = `
def initialize(context):
    context.set_universe(["US:TEST"])
    context.subscribe(frequency="1d")

def handle_data(context, data):
    order_target_percent("US:TEST", 0.25, reason="keep_target")
`;
    const bars = Array.from({ length: 8 }, (_, i) => ({
      symbol: "TEST",
      exchange: "US",
      timestamp: `2024-02-${String(i + 1).padStart(2, "0")}`,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 1000,
      turnover: 0,
    }));
    const r = await backtestStrategyContract({
      strategyCode: code,
      bars,
      symbol: "US:TEST",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pendingIntents?.[0]).toMatchObject({
      kind: "target_percent",
      value: 0.25,
    });
  });

  test("compile normalizes set_universe string US-NVDA", async () => {
    const code = `
def initialize(context):
    context.set_universe("US-NVDA")
    context.subscribe(frequency="1d", fields=["close"])
    context.set_warmup(5)

def handle_data(context, data):
    pass
`;
    const r = await compileStrategyContract(code);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.universe.instruments[0]?.instrumentId).toBe("US:NVDA");
  });

  test("compile accepts set_universe list", async () => {
    const code = `
def initialize(context):
    context.set_universe(["US:AAPL"])
    context.subscribe(frequency="1d")
    context.set_warmup(2)

def handle_data(context, data):
    pass
`;
    const r = await compileStrategyContract(code);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.universe.instruments[0]?.instrumentId).toBe("US:AAPL");
  });

  test("instrumentIdToKlinesSymbol strips prefix", () => {
    expect(instrumentIdToKlinesSymbol("US:SPY")).toBe("SPY");
    expect(instrumentIdToKlinesSymbol("CN:600519.SH")).toBe("600519.SH");
    expect(instrumentIdToKlinesSymbol("AAPL")).toBe("AAPL");
  });
});
