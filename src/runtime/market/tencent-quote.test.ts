import { describe, expect, test } from "bun:test";
import { parseTencentQuotePayload } from "./tencent-quote";

describe("Tencent realtime quote", () => {
  test("parses normalized price and freshness fields", () => {
    const fields = Array.from({ length: 40 }, () => "");
    fields[1] = "兆易创新";
    fields[2] = "603986";
    fields[3] = "123.45";
    fields[4] = "120.00";
    fields[5] = "121.00";
    fields[6] = "1234";
    fields[30] = "20260727141530";
    fields[33] = "125.00";
    fields[34] = "119.50";
    const quote = parseTencentQuotePayload(`v_sh603986="${fields.join("~")}";`, {
      symbol: "603986.SH",
      exchange: "SH",
    });
    expect(quote).toMatchObject({
      source: "tencent",
      lastPrice: 123.45,
      previousClose: 120,
      open: 121,
      high: 125,
      low: 119.5,
      volume: 123_400,
      timestamp: "2026-07-27T06:15:30.000Z",
    });
  });
});
