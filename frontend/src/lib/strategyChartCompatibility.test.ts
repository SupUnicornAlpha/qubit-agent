import { describe, expect, test } from "bun:test";
import { assessStrategyChartCompatibility } from "./strategyChartCompatibility";

const manifest = (overrides: Record<string, unknown> = {}) => ({
  apiVersion: 2,
  codeHash: "test",
  strategyType: "cta",
  universe: { kind: "static", instruments: [{ market: "US", symbol: "NVDA", instrumentId: "US:NVDA" }] },
  handlers: ["handle_data"],
  warmupBars: 20,
  primaryFrequency: "5m",
  paramsSchema: [],
  metadata: {},
  ...overrides,
});

describe("assessStrategyChartCompatibility", () => {
  test("requires the current symbol and K-line timeframe to match the strategy", () => {
    expect(assessStrategyChartCompatibility({ manifest: manifest() as never, symbol: "NVDA", exchange: "NASDAQ", timeframe: "5m" }).compatible).toBe(true);
    expect(assessStrategyChartCompatibility({ manifest: manifest() as never, symbol: "AAPL", exchange: "US", timeframe: "5m" }).compatible).toBe(false);
    expect(assessStrategyChartCompatibility({ manifest: manifest() as never, symbol: "NVDA", exchange: "US", timeframe: "1d" }).reason).toContain("策略主周期");
  });

  test("requires a declared proxy K-line for a basket strategy", () => {
    const basket = manifest({
      universe: { kind: "pool", instruments: [{ market: "POOL", symbol: "SEMIS", instrumentId: "POOL:SEMIS" }] },
      metadata: { members: ["US:NVDA", "US:AMD"] },
    });
    expect(assessStrategyChartCompatibility({ manifest: basket as never, symbol: "NVDA", exchange: "US", timeframe: "5m" }).compatible).toBe(false);
    const proxy = manifest({
      universe: { kind: "pool", instruments: [{ market: "POOL", symbol: "SEMIS", instrumentId: "POOL:SEMIS" }] },
      metadata: { members: ["US:NVDA", "US:AMD"], backtestInstrument: "US:SOXX" },
    });
    expect(assessStrategyChartCompatibility({ manifest: proxy as never, symbol: "SOXX", exchange: "NASDAQ", timeframe: "5m" }).compatible).toBe(true);
  });
});
