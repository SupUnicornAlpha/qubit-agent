import { describe, expect, test } from "bun:test";
import { buildResearchMarketSymbolList, symbolsFromResearchScope } from "./researchMarketSymbols";

describe("researchMarketSymbols", () => {
  test("basket expands to all symbols", () => {
    const rows = symbolsFromResearchScope({
      mode: "basket",
      ticker: "",
      basketTickers: "AAPL, MSFT, NVDA",
      sectorPeers: "",
      instrument: "equity_long",
      optionUnderlying: "",
    });
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  test("merges focus + scope + tool hits without duplicates", () => {
    const list = buildResearchMarketSymbolList({
      focusSymbol: "AAPL",
      focusExchange: "US",
      scope: {
        mode: "basket",
        ticker: "",
        basketTickers: "AAPL, TSLA",
        sectorPeers: "",
        instrument: "equity_long",
        optionUnderlying: "",
      },
      toolHits: [
        {
          id: "t1",
          kind: "market",
          toolName: "fetch_klines",
          agentRole: "research",
          status: "success",
          createdAt: "2026-08-04T00:00:00.000Z",
          symbol: "MSFT",
          exchange: "US",
          latencyMs: 10,
          errorMessage: null,
        },
      ],
      limit: 8,
    });
    expect(list.map((r) => r.symbol)).toEqual(["AAPL", "TSLA", "MSFT"]);
    expect(list[0]?.source).toBe("focus");
  });
});
