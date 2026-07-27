import { describe, expect, test } from "bun:test";
import { parseEastMoneyTradeRow } from "./eastmoney-microstructure";

describe("parseEastMoneyTradeRow", () => {
  test("normalizes an active buy trade", () => {
    const trade = parseEastMoneyTradeRow(
      "09:30:01,12.34,500,2,1",
      { symbol: "000001", exchange: "SZ", limit: 10 },
      0
    );
    expect(trade?.price).toBe(12.34);
    expect(trade?.volume).toBe(500);
    expect(trade?.side).toBe("buy");
    expect(trade?.source).toBe("eastmoney");
  });

  test("rejects malformed rows", () => {
    expect(
      parseEastMoneyTradeRow("bad", { symbol: "000001", exchange: "SZ" }, 0)
    ).toBeNull();
  });

  test("uses the provider trading date instead of the local calendar date", () => {
    const trade = parseEastMoneyTradeRow(
      "15:28:04,1297.41,4,4,1",
      { symbol: "600519", exchange: "SH" },
      0,
      "2026-07-24T08:11:33.000Z"
    );
    expect(trade?.timestamp).toBe("2026-07-24T07:28:04.000Z");
  });
});
