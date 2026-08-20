import { describe, expect, test } from "bun:test";
import { resolveWatchlistExchange } from "./watchlist-service";

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
