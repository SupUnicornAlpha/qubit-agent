import { describe, expect, test } from "bun:test";
import { resolveEffectiveKlinesSource, symbolToYahooSymbol } from "./klines-data-source";

describe("symbolToYahooSymbol", () => {
  test("A-share SH / SZ", () => {
    expect(symbolToYahooSymbol("600000", "SH")).toBe("600000.SS");
    expect(symbolToYahooSymbol("000001", "SZ")).toBe("000001.SZ");
    expect(symbolToYahooSymbol("600000.SH", "")).toBe("600000.SS");
  });

  test("US ticker", () => {
    expect(symbolToYahooSymbol("AAPL", "")).toBe("AAPL");
    expect(symbolToYahooSymbol("AAPL", "US")).toBe("AAPL");
    expect(symbolToYahooSymbol("ASTS", "US")).toBe("ASTS");
  });

  test("six digits without exchange defaults to Shanghai suffix", () => {
    expect(symbolToYahooSymbol("600000", "")).toBe("600000.SS");
  });

  test("other venues", () => {
    expect(symbolToYahooSymbol("7203", "JP")).toBe("7203.T");
    expect(symbolToYahooSymbol("VOD", "UK")).toBe("VOD.L");
    expect(symbolToYahooSymbol("SAP", "DE")).toBe("SAP.DE");
    expect(symbolToYahooSymbol("AIR", "FR")).toBe("AIR.PA");
    expect(symbolToYahooSymbol("SHOP", "CA")).toBe("SHOP.TO");
    expect(symbolToYahooSymbol("BHP", "AU")).toBe("BHP.AX");
    expect(symbolToYahooSymbol("005930", "KR")).toBe("005930.KS");
    expect(symbolToYahooSymbol("035420", "KQ")).toBe("035420.KQ");
    expect(symbolToYahooSymbol("2330", "TW")).toBe("2330.TW");
    expect(symbolToYahooSymbol("D05", "SG")).toBe("D05.SI");
    expect(symbolToYahooSymbol("RELIANCE", "IN")).toBe("RELIANCE.NS");
  });
});

describe("resolveEffectiveKlinesSource", () => {
  const base = { "qubit-data": {}, "qubit-news": {} };

  test("auto + token uses tushare for 1d", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: true,
      })
    ).toBe("tushare_daily");
  });

  test("auto + no token uses yahoo for 1d", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
      })
    ).toBe("yahoo_chart");
  });

  test("intraday resolves to synthetic", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "yahoo_chart" } },
        period: "5m",
        hasTushareToken: false,
      })
    ).toBe("synthetic");
  });
});
