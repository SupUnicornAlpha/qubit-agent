import { describe, expect, test } from "bun:test";
import { evaluateConditionalTrigger } from "./conditional-order-service";

describe("evaluateConditionalTrigger", () => {
  test("triggers sell and buy stops in the correct direction", () => {
    expect(evaluateConditionalTrigger({
      orderType: "stop", side: "sell", markPrice: 94, stopPrice: 95,
    }).triggered).toBe(true);
    expect(evaluateConditionalTrigger({
      orderType: "stop", side: "sell", markPrice: 96, stopPrice: 95,
    }).triggered).toBe(false);
    expect(evaluateConditionalTrigger({
      orderType: "stop_limit", side: "buy", markPrice: 101, stopPrice: 100,
    }).triggered).toBe(true);
    expect(evaluateConditionalTrigger({
      orderType: "stop_limit",
      side: "sell",
      markPrice: 110,
      stopPrice: 110,
      triggerDirection: "above",
    }).triggered).toBe(true);
  });

  test("raises a sell trailing anchor and triggers only after drawdown", () => {
    const rising = evaluateConditionalTrigger({
      orderType: "trailing_stop",
      side: "sell",
      markPrice: 110,
      trailingOffsetPct: 0.1,
      trailingAnchorPrice: 100,
    });
    expect(rising.nextAnchorPrice).toBe(110);
    expect(rising.triggerPrice).toBeCloseTo(99);
    expect(rising.triggered).toBe(false);

    const falling = evaluateConditionalTrigger({
      orderType: "trailing_stop",
      side: "sell",
      markPrice: 98,
      trailingOffsetPct: 0.1,
      trailingAnchorPrice: rising.nextAnchorPrice,
    });
    expect(falling.nextAnchorPrice).toBe(110);
    expect(falling.triggered).toBe(true);
  });

  test("lowers a buy trailing anchor", () => {
    const result = evaluateConditionalTrigger({
      orderType: "trailing_stop",
      side: "buy",
      markPrice: 90,
      trailingOffsetPct: 0.05,
      trailingAnchorPrice: 100,
    });
    expect(result.nextAnchorPrice).toBe(90);
    expect(result.triggerPrice).toBeCloseTo(94.5);
    expect(result.triggered).toBe(false);
  });
});
