import { describe, expect, test } from "bun:test";
import type { OptionChain, OptionContract } from "../api/types";
import { deriveOptionStrategy, nearestOptionStrike } from "./optionStrategy";

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
  expirations: ["2026-09-18"],
  calls: [contract("call", 95, 7, 7.2), contract("call", 100, 4, 4.2), contract("call", 105, 2, 2.2)],
  puts: [contract("put", 95, 1.8, 2), contract("put", 100, 3.8, 4), contract("put", 105, 6.8, 7)],
};

describe("option strategy estimates", () => {
  test("uses the nearest strike and ask prices for a bought wide strangle", () => {
    expect(nearestOptionStrike(chain, 101)).toBe(100);
    const estimate = deriveOptionStrategy(chain, 101, {
      kind: "long_strangle",
      centerStrike: 100,
      wingSteps: 1,
      singleRight: "call",
      singleSide: "buy",
    });
    expect(estimate.legs).toHaveLength(2);
    expect(estimate.legs.map(({ contract }) => contract.strike)).toEqual([95, 105]);
    expect(estimate.netDebit).toBe(420);
    expect(estimate.breakEvens).toEqual([90.8, 109.2]);
  });

  test("uses bid prices for a sold single leg", () => {
    const estimate = deriveOptionStrategy(chain, 100, {
      kind: "single",
      centerStrike: 100,
      wingSteps: 1,
      singleRight: "call",
      singleSide: "sell",
    });
    expect(estimate.netDebit).toBe(-400);
    expect(estimate.scenarioPnl[1]?.pnl).toBe(400);
  });
});
