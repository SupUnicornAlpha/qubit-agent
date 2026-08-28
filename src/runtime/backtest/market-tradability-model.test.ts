import { describe, expect, test } from "bun:test";
import { assessOpenTradability } from "./market-tradability-model";

describe("market tradability model", () => {
  test("blocks suspended and explicitly untradable bars", () => {
    expect(assessOpenTradability({ open: 10, suspended: true }, "buy").reason).toBe("suspended");
    expect(assessOpenTradability({ open: 10, tradable: false }, "sell").executable).toBe(false);
  });

  test("blocks a bar marked closed by the frozen exchange calendar", () => {
    expect(assessOpenTradability({ open: 10, calendarSession: "closed" }, "buy")).toEqual({
      executable: false,
      reason: "calendar_closed",
    });
  });

  test("applies directional price-limit constraints", () => {
    expect(assessOpenTradability({ open: 11, priceLimitUp: 11 }, "buy").executable).toBe(false);
    expect(assessOpenTradability({ open: 11, priceLimitUp: 11 }, "sell").executable).toBe(true);
    expect(assessOpenTradability({ open: 9, priceLimitDown: 9 }, "sell").executable).toBe(false);
  });
});
