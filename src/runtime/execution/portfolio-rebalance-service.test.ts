import { describe, expect, test } from "bun:test";
import { buildPortfolioRebalancePlan } from "./portfolio-rebalance-service";

describe("portfolio rebalance plan", () => {
  test("creates deterministic buy and sell orders", () => {
    const rows = [
      { symbol: "BBB", price: 50, rebalanceQty: -3.8 },
      { symbol: "AAA", price: 100, rebalanceQty: 12.4 },
      { symbol: "TINY", price: 10, rebalanceQty: 0.4 },
    ] as never;
    const first = buildPortfolioRebalancePlan(rows);
    const second = buildPortfolioRebalancePlan([...rows].reverse());
    expect(first.planHash).toBe(second.planHash);
    expect(first.orders).toEqual([
      { symbol: "AAA", side: "buy", qty: 12, referencePrice: 100 },
      { symbol: "BBB", side: "sell", qty: 3, referencePrice: 50 },
    ]);
  });
});
