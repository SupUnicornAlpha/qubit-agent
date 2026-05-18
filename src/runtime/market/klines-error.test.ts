import { describe, expect, test } from "bun:test";
import { buildKlinesEmptyError, KLINES_ERROR_TYPE, wrapKlinesThrownError } from "./klines-error";

describe("klines-error", () => {
  test("buildKlinesEmptyError", () => {
    const err = buildKlinesEmptyError({
      symbol: "AAPL",
      exchange: "US",
      timeframe: "4h",
      period: "4h",
      dataSource: "akshare",
      requestedLimit: 120,
    });
    expect(err.type).toBe(KLINES_ERROR_TYPE.EMPTY);
    expect(err.code).toBe("akshare_no_bars");
    expect(err.message).toContain("AAPL");
    expect(err.hint).toContain("yahoo_chart");
  });

  test("wrapKlinesThrownError", () => {
    expect(wrapKlinesThrownError(new Error("symbol is required")).type).toBe(
      KLINES_ERROR_TYPE.INVALID_REQUEST
    );
    expect(wrapKlinesThrownError(new Error("qubit-data connector is not registered")).type).toBe(
      KLINES_ERROR_TYPE.CONNECTOR_UNAVAILABLE
    );
  });
});
