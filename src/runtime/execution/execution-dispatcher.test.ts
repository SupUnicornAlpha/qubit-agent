import { describe, expect, test } from "bun:test";
import { assertDispatchableOrderType, resolveEffectiveOrderType } from "./execution-dispatcher";

describe("assertDispatchableOrderType", () => {
  test("accepts broker-supported order types", () => {
    expect(() => assertDispatchableOrderType("market", "live")).not.toThrow();
    expect(() => assertDispatchableOrderType("limit", "paper")).not.toThrow();
  });

  test("never silently downgrades conditional orders", () => {
    expect(() => assertDispatchableOrderType("stop", "paper")).toThrow(
      "conditional_order_not_supported:paper:stop",
    );
    expect(() => assertDispatchableOrderType("stop_limit", "live")).toThrow(
      "conditional_order_not_supported:live:stop_limit",
    );
  });

  test("maps only triggered conditional orders to broker-supported types", () => {
    expect(() => resolveEffectiveOrderType("stop", "waiting_trigger")).toThrow(
      "conditional_order_not_triggered:stop",
    );
    expect(resolveEffectiveOrderType("stop", "triggered")).toBe("market");
    expect(resolveEffectiveOrderType("trailing_stop", "triggered")).toBe("market");
    expect(resolveEffectiveOrderType("stop_limit", "triggered")).toBe("limit");
  });
});
