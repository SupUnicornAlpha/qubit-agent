import { describe, expect, test } from "bun:test";
import { parseWatchlistIncludePositionsQuery, resolveWatchlistExchange } from "./watchlist-service";

describe("resolveWatchlistExchange", () => {
  test("turns AUTO broker symbols into canonical subscription markets", () => {
    expect(resolveWatchlistExchange("BABA", "AUTO")).toBe("US");
    expect(resolveWatchlistExchange("600519", "AUTO")).toBe("SH");
    expect(resolveWatchlistExchange("000001", "")).toBe("SZ");
    expect(resolveWatchlistExchange("00700", "UNKNOWN")).toBe("HK");
  });

  test("honours a user or broker supplied market when it is explicit", () => {
    expect(resolveWatchlistExchange("BABA", "HKEX")).toBe("HK");
    expect(resolveWatchlistExchange("BTCUSDT", "BINANCE")).toBe("CRYPTO");
  });
});

describe("parseWatchlistIncludePositionsQuery", () => {
  test("defaults to local watchlist only so the symbol list never waits on brokers", () => {
    expect(parseWatchlistIncludePositionsQuery(undefined)).toBe(false);
    expect(parseWatchlistIncludePositionsQuery("")).toBe(false);
    expect(parseWatchlistIncludePositionsQuery("0")).toBe(false);
    expect(parseWatchlistIncludePositionsQuery("false")).toBe(false);
  });

  test("opt-in only when the client explicitly asks for live broker positions", () => {
    expect(parseWatchlistIncludePositionsQuery("1")).toBe(true);
    expect(parseWatchlistIncludePositionsQuery("true")).toBe(true);
    expect(parseWatchlistIncludePositionsQuery("YES")).toBe(true);
  });
});
