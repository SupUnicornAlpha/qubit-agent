import { describe, expect, test } from "bun:test";
import { guessChartExchangeFromSymbol } from "./chartSpec";
import { chartPatchFromResearchScope, primarySymbolFromResearchScope } from "./researchScopeChartLink";

describe("researchScopeChartLink", () => {
  test("guesses exchange from symbol shape", () => {
    expect(guessChartExchangeFromSymbol("600519")).toBe("SH");
    expect(guessChartExchangeFromSymbol("000001")).toBe("SZ");
    expect(guessChartExchangeFromSymbol("AAPL")).toBe("US");
    expect(guessChartExchangeFromSymbol("00700")).toBe("HK");
  });

  test("single ticker becomes primary symbol", () => {
    expect(
      primarySymbolFromResearchScope({
        mode: "single",
        ticker: "nvda",
        basketTickers: "",
        sectorPeers: "",
        instrument: "equity_long",
        optionUnderlying: "",
      })
    ).toBe("NVDA");
  });

  test("basket uses first symbol", () => {
    const patch = chartPatchFromResearchScope({
      mode: "basket",
      ticker: "",
      basketTickers: "AAPL, MSFT",
      sectorPeers: "",
      instrument: "equity_long",
      optionUnderlying: "",
    });
    expect(patch).toEqual({ symbol: "AAPL", exchange: "US" });
  });

  test("option uses underlying", () => {
    expect(
      primarySymbolFromResearchScope({
        mode: "single",
        ticker: "OCCCONTRACT",
        basketTickers: "",
        sectorPeers: "",
        instrument: "option",
        optionUnderlying: "TSLA",
      })
    ).toBe("TSLA");
  });
});
