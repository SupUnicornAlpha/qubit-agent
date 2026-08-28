import { describe, expect, it } from "vitest";
import {
  calculateDailyBorrowCost,
  calculateExecutionImpact,
} from "./market-impact-model";

describe("Market Impact & Slippage Models", () => {
  const sampleBar = {
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 100_000,
  };

  it("calculates fixed bps slippage correctly", () => {
    const buyResult = calculateExecutionImpact({
      symbol: "AAPL",
      side: "buy",
      nominalPrice: 100,
      qty: 1000,
      bar: sampleBar,
      config: {
        model: "fixed_bps",
        baseSlippageBps: 10, // 0.1%
      },
    });

    expect(buyResult.slippageRate).toBeCloseTo(0.001);
    expect(buyResult.effectivePrice).toBeCloseTo(100.1);
    expect(buyResult.impactBps).toBe(10);
    expect(buyResult.actualFilledQty).toBe(1000);
    expect(buyResult.liquidityCapped).toBe(false);

    const sellResult = calculateExecutionImpact({
      symbol: "AAPL",
      side: "sell",
      nominalPrice: 100,
      qty: 1000,
      bar: sampleBar,
      config: {
        model: "fixed_bps",
        baseSlippageBps: 10,
      },
    });

    expect(sellResult.effectivePrice).toBeCloseTo(99.9);
  });

  it("calculates square root market impact based on order size vs bar volume", () => {
    const smallOrder = calculateExecutionImpact({
      symbol: "MSFT",
      side: "buy",
      nominalPrice: 200,
      qty: 1_000, // 1% of volume
      bar: { ...sampleBar, open: 200, high: 204, low: 198, close: 202, volume: 100_000 },
      config: {
        model: "square_root",
        baseSlippageBps: 5,
        impactCoefficient: 0.1,
      },
    });

    const largeOrder = calculateExecutionImpact({
      symbol: "MSFT",
      side: "buy",
      nominalPrice: 200,
      qty: 25_000, // 25% of volume
      bar: { ...sampleBar, open: 200, high: 204, low: 198, close: 202, volume: 100_000 },
      config: {
        model: "square_root",
        baseSlippageBps: 5,
        impactCoefficient: 0.1,
      },
    });

    expect(largeOrder.impactBps).toBeGreaterThan(smallOrder.impactBps);
    expect(largeOrder.effectivePrice).toBeGreaterThan(smallOrder.effectivePrice);
  });

  it("enforces max volume participation liquidity limit", () => {
    const cappedResult = calculateExecutionImpact({
      symbol: "TSLA",
      side: "buy",
      nominalPrice: 150,
      qty: 20_000, // Wants 20k
      bar: { ...sampleBar, volume: 100_000 },
      config: {
        model: "fixed_bps",
        baseSlippageBps: 5,
        maxVolumeParticipation: 0.1, // Max 10% = 10k
      },
    });

    expect(cappedResult.liquidityCapped).toBe(true);
    expect(cappedResult.actualFilledQty).toBe(10_000);
    expect(cappedResult.unfilledQty).toBe(10_000);
  });

  it("calculates short position daily borrow cost correctly", () => {
    const shortNotional = 100_000;
    const annualBps = 365; // 3.65% annual -> 0.01% daily = $10 / day
    const cost = calculateDailyBorrowCost(shortNotional, annualBps, 1);
    expect(cost).toBeCloseTo(10, 2);
  });
});
