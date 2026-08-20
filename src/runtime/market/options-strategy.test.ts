import { describe, expect, test } from "bun:test";
import type { OptionChain, OptionContract } from "./options-chain";
import { analyzeOptionStrategy } from "./options-strategy";

const contract = (right: "call" | "put", strike: number, bid: number, ask: number): OptionContract => ({
  contractSymbol: `TEST${strike}${right === "call" ? "C" : "P"}`,
  right,
  strike,
  lastPrice: (bid + ask) / 2,
  bid,
  ask,
  change: null,
  percentChange: null,
  volume: null,
  openInterest: null,
  impliedVolatility: 0.2,
  inTheMoney: false,
  expiration: "2026-09-18",
  greeks: { delta: right === "call" ? 0.4 : -0.4, gamma: 0.02, vega: 0.1, theta: -0.03, rho: null },
});

const chain: OptionChain = {
  underlying: "TEST",
  source: "yfinance",
  feedClass: "L0_research_fallback",
  licenseUse: "research_only",
  fallbackUsed: false,
  fetchedAt: "2026-08-20T00:00:00.000Z",
  expirations: ["2026-09-18", "2026-10-16"],
  calls: [contract("call", 95, 7, 7.2), contract("call", 100, 4, 4.2), contract("call", 105, 2, 2.2)],
  puts: [contract("put", 95, 1.8, 2), contract("put", 100, 3.8, 4), contract("put", 105, 6.8, 7)],
};

describe("option strategy analysis", () => {
  test("calculates long strangle breakevens and expiry P&L", () => {
    const result = analyzeOptionStrategy({ strategy: "strangle", centerStrike: 100, widthSteps: 1 }, [chain], 100);
    expect(result.legs).toHaveLength(2);
    expect(result.netPremium).toBe(420);
    expect(result.expiryBreakEvens).toEqual([90.8, 109.2]);
    expect(result.expiryScenarios[1]?.pnl).toBe(-420);
  });

  test("builds all four legs of an iron condor", () => {
    const result = analyzeOptionStrategy({ strategy: "iron_condor", centerStrike: 100, widthSteps: 1 }, [chain], 100);
    expect(result.legs).toHaveLength(4);
    expect(result.legs.map((leg) => leg.action)).toEqual(["buy", "sell", "sell", "buy"]);
    // Bid/ask execution assumptions make a freshly constructed short premium
    // position start below mid-market by the combined spread cost.
    expect(result.markToMarketPnl).toBeCloseTo(-40);
  });
});
