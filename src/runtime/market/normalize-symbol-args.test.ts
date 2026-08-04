import { describe, expect, test } from "bun:test";
import {
  extractSymbolArgs,
  requireSymbols,
  ToolContractParamError,
} from "./normalize-symbol-args";

describe("extractSymbolArgs / requireSymbols", () => {
  test("accepts symbol / ticker / symbols / tickers aliases", () => {
    expect(extractSymbolArgs({ symbol: "AAPL" })).toEqual(["AAPL"]);
    expect(extractSymbolArgs({ ticker: "603986.SH" })).toEqual(["603986.SH"]);
    expect(extractSymbolArgs({ symbols: ["A", "B"] })).toEqual(["A", "B"]);
    expect(extractSymbolArgs({ tickers: ["X", "Y"] })).toEqual(["X", "Y"]);
  });

  test("DB repro: symbols[] alone is enough", () => {
    expect(extractSymbolArgs({ symbols: ["603986.SH", "002384.SZ"] })).toEqual([
      "603986.SH",
      "002384.SZ",
    ]);
  });

  test("accepts symbols as scalar string (common LLM mistake)", () => {
    expect(extractSymbolArgs({ symbols: "AAPL" })).toEqual(["AAPL"]);
    expect(extractSymbolArgs({ symbols: "AAPL,MSFT" })).toEqual(["AAPL", "MSFT"]);
    expect(extractSymbolArgs({ tickers: "603986.SH" })).toEqual(["603986.SH"]);
  });

  test("requireSymbols missing → missing_symbol + receivedKeys", () => {
    expect(() => requireSymbols({}, { arity: "either", toolName: "fetch_quote" })).toThrow(
      ToolContractParamError
    );
    try {
      requireSymbols({}, { arity: "either", toolName: "fetch_quote" });
    } catch (err) {
      expect(err).toBeInstanceOf(ToolContractParamError);
      const e = err as ToolContractParamError;
      expect(e.code).toBe("missing_symbol");
      expect(e.message).toContain("receivedKeys=(none)");
    }
  });

  test("arity one rejects multi-symbol", () => {
    expect(() =>
      requireSymbols({ symbols: ["A", "B"] }, { arity: "one", toolName: "fetch_ticks" })
    ).toThrow(/arity_violation/);
  });
});
