import { describe, expect, test } from "bun:test";
import {
  FUTU_DEFAULT_TRADE_BASE_URL,
  applyFutuAccountDefaults,
  defaultFutuTradeBaseUrl,
} from "./futu-runtime";

describe("futu-runtime defaults", () => {
  test("fills trade baseUrl for sandbox/live when empty", () => {
    expect(applyFutuAccountDefaults({ provider: "futu", mode: "sandbox" })).toEqual({
      baseUrl: FUTU_DEFAULT_TRADE_BASE_URL,
    });
    expect(applyFutuAccountDefaults({ provider: "futu", mode: "live" })).toEqual({
      baseUrl: FUTU_DEFAULT_TRADE_BASE_URL,
    });
    expect(applyFutuAccountDefaults({ provider: "futu", mode: "mock" })).toEqual({});
    expect(
      applyFutuAccountDefaults({
        provider: "futu",
        mode: "sandbox",
        baseUrl: "http://127.0.0.1:19999",
      })
    ).toEqual({});
    expect(applyFutuAccountDefaults({ provider: "ib", mode: "sandbox" })).toEqual({});
  });

  test("defaultFutuTradeBaseUrl", () => {
    expect(defaultFutuTradeBaseUrl(null)).toBe(FUTU_DEFAULT_TRADE_BASE_URL);
    expect(defaultFutuTradeBaseUrl("  ")).toBe(FUTU_DEFAULT_TRADE_BASE_URL);
    expect(defaultFutuTradeBaseUrl("http://x:1")).toBe("http://x:1");
  });
});
