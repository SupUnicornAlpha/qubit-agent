import { describe, expect, test } from "bun:test";
import { extractKlinesSymbols, normalizeKlinesToolRequest } from "./normalize-klines-request";

describe("normalizeKlinesToolRequest", () => {
  test("accepts common agent aliases and infers Shenzhen without generic CN overriding it", () => {
    expect(
      normalizeKlinesToolRequest({
        ticker: "300274.SZ",
        market: "CN",
        interval: "daily",
        count: 250,
      })
    ).toEqual({
      symbol: "300274",
      exchange: "SZ",
      timeframe: "1d",
      limit: 250,
    });
  });

  test("normalizes vendor-prefixed symbols and intraday aliases", () => {
    expect(
      normalizeKlinesToolRequest({
        securityCode: "SH600000",
        frequency: "60m",
        lookbackDays: 30,
      })
    ).toEqual({
      symbol: "600000",
      exchange: "SH",
      timeframe: "1h",
      limit: 30,
    });
  });

  test("supports US suffix and clamps loose limits", () => {
    expect(
      normalizeKlinesToolRequest({
        instrument: "AAPL.US",
        period: "1week",
        bars: 5000,
      })
    ).toEqual({
      symbol: "AAPL",
      exchange: "US",
      timeframe: "1w",
      limit: 2000,
    });
  });

  test("extracts and deduplicates batch symbol aliases", () => {
    expect(extractKlinesSymbols({ tickers: ["600000", "300274", "600000"] })).toEqual([
      "600000",
      "300274",
    ]);
  });

  test("accepts symbols/tickers as scalar string", () => {
    expect(extractKlinesSymbols({ symbols: "AAPL" })).toEqual(["AAPL"]);
    expect(
      normalizeKlinesToolRequest({
        symbols: "AAPL",
        exchange: "US",
        timeframe: "1d",
        limit: 300,
      })
    ).toMatchObject({ symbol: "AAPL", exchange: "US", timeframe: "1d", limit: 300 });
  });

  test("splits watchlists passed through a singular symbol alias", () => {
    expect(extractKlinesSymbols({ symbol: "AAPL,BABA, ASTS；NVDA" })).toEqual([
      "AAPL",
      "BABA",
      "ASTS",
      "NVDA",
    ]);
    expect(extractKlinesSymbols({ symbols: ["AAPL,MSFT", "NVDA"] })).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
    ]);
    expect(extractKlinesSymbols({ symbol: "BTC/USDT" })).toEqual(["BTC/USDT"]);
  });

  test("accepts snake-case explicit date windows used by older agents", () => {
    const result = normalizeKlinesToolRequest({
      symbol: "^VIX",
      start_time: "2026-01-01",
      end_time: "2026-02-01",
    });
    expect(result.startDate).toBe("2026-01-01T00:00:00.000Z");
    expect(result.endDate).toBe("2026-02-01T00:00:00.000Z");
  });

  test("fills start from endDate + limit when only end is provided", () => {
    const result = normalizeKlinesToolRequest(
      {
        symbol: "603986.SH",
        endDate: "2026-08-03",
        limit: 10,
        timeframe: "1d",
      },
      { asOfMs: Date.parse("2026-08-03T12:00:00Z") }
    );
    expect(result.endDate).toBe("2026-08-03T00:00:00.000Z");
    expect(result.startDate).toBeDefined();
    const start = Date.parse(result.startDate!);
    const end = Date.parse(result.endDate!);
    expect(end - start).toBe(9 * 24 * 60 * 60 * 1000);
  });

  test("defaults limit to 250 when omitted", () => {
    const result = normalizeKlinesToolRequest({ ticker: "600519.SH" });
    expect(result.limit).toBe(250);
  });
});
