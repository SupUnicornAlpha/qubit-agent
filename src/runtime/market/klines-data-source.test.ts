import { describe, expect, test } from "bun:test";
import { isCryptoMarket } from "./crypto-market";
import { symbolToEastMoneySecId } from "./eastmoney-klines";
import {
  resolveEffectiveKlinesSource,
  splitRangeForYahoo,
  symbolToYahooSymbol,
} from "./klines-data-source";

describe("symbolToEastMoneySecId — resolver-driven 空 exchange 兜底", () => {
  test("显式后缀仍优先（向后兼容）", () => {
    expect(symbolToEastMoneySecId("600519.SH", "")).toBe("1.600519");
    expect(symbolToEastMoneySecId("000001.SZ", "")).toBe("0.000001");
    expect(symbolToEastMoneySecId("872925.BJ", "")).toBe("0.872925");
  });
  test("显式 exchange 仍优先", () => {
    expect(symbolToEastMoneySecId("600519", "SH")).toBe("1.600519");
    expect(symbolToEastMoneySecId("000001", "SZ")).toBe("0.000001");
  });
  test("评估报告 P0 修复：空 exchange 时按首位精确分流（不再一律 1.xxx）", () => {
    expect(symbolToEastMoneySecId("600519", "")).toBe("1.600519"); // 6 → SH
    expect(symbolToEastMoneySecId("688981", "")).toBe("1.688981"); // 6 → SH (科创板)
    // P0 bug fix：000001 不再被错路到 1.000001（上证综指）
    expect(symbolToEastMoneySecId("000001", "")).toBe("0.000001"); // 0 → SZ
    expect(symbolToEastMoneySecId("300750", "")).toBe("0.300750"); // 3 → SZ
    expect(symbolToEastMoneySecId("872925", "")).toBe("0.872925"); // 8 → BJ
    expect(symbolToEastMoneySecId("430047", "")).toBe("0.430047"); // 4 → BJ
  });
});

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

  test("six digits without exchange — resolver-driven SH/SZ", () => {
    // 6 头沪市保持 .SS
    expect(symbolToYahooSymbol("600000", "")).toBe("600000.SS");
    expect(symbolToYahooSymbol("688981", "")).toBe("688981.SS"); // 科创板
    // 评估报告 P0 修复点：0 头深市不再被错路到 .SS
    expect(symbolToYahooSymbol("000001", "")).toBe("000001.SZ"); // 平安银行
    expect(symbolToYahooSymbol("300750", "")).toBe("300750.SZ"); // 宁德时代 / 创业板
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
    expect(symbolToYahooSymbol("ASML", "NL")).toBe("ASML.AS");
    expect(symbolToYahooSymbol("NESN", "CH")).toBe("NESN.SW");
    expect(symbolToYahooSymbol("ENI", "IT")).toBe("ENI.MI");
    expect(symbolToYahooSymbol("SAN", "ES")).toBe("SAN.MC");
    expect(symbolToYahooSymbol("BTC", "CRYPTO")).toBe("BTC-USD");
    expect(symbolToYahooSymbol("ETH-USD", "CRYPTO")).toBe("ETH-USD");
  });
});

describe("resolveEffectiveKlinesSource", () => {
  const base = { "qubit-data": {}, "qubit-news": {} };

  test("auto + wind username prefers wind for CN A-share", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: {
          ...base,
          "qubit-data": { klinesDataSource: "auto", windUsername: "demo" },
        },
        period: "1d",
        hasTushareToken: true,
        hasWindAvailable: true,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("wind");
  });

  test("explicit wind mode when available", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "wind" } },
        period: "1d",
        hasTushareToken: false,
        hasWindAvailable: true,
      })
    ).toBe("wind");
  });

  test("wind mode without availability falls back to synthetic", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "wind" } },
        period: "1d",
        hasTushareToken: false,
        hasWindAvailable: false,
      })
    ).toBe("synthetic");
  });

  test("auto + token uses tushare for 1d", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: true,
      })
    ).toBe("tushare_daily");
  });

  test("auto + no token + A-share uses eastmoney for 1d", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("eastmoney");
  });

  test("auto + no token + US uses yahoo for 1d", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
        symbol: "AAPL",
        exchange: "US",
      })
    ).toBe("yahoo_chart");
  });

  test("intraday auto + A-share uses eastmoney", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "5m",
        hasTushareToken: false,
        symbol: "600000",
        exchange: "SH",
      })
    ).toBe("eastmoney");
  });

  test("explicit eastmoney mode", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "eastmoney" } },
        period: "5m",
        hasTushareToken: false,
      })
    ).toBe("eastmoney");
  });

  test("explicit akshare mode", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "akshare" } },
        period: "1d",
        hasTushareToken: false,
      })
    ).toBe("akshare");
  });

  test("explicit yfinance mode", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "yfinance" } },
        period: "1d",
        hasTushareToken: false,
      })
    ).toBe("yfinance");
  });

  test("auto does NOT silently route to yfinance even for US tickers", () => {
    /** 决议 §10.3：auto 保持走 yahoo_chart 直连，避免没装 Python 的用户被坑。 */
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1d",
        hasTushareToken: false,
        symbol: "AAPL",
        exchange: "US",
      })
    ).toBe("yahoo_chart");
  });

  test("auto + crypto uses binance_crypto", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "auto" } },
        period: "1h",
        hasTushareToken: true,
        symbol: "BTCUSDT",
        exchange: "CRYPTO",
      })
    ).toBe("binance_crypto");
  });

  test("explicit binance_crypto mode", () => {
    expect(
      resolveEffectiveKlinesSource({
        settings: { ...base, "qubit-data": { klinesDataSource: "binance_crypto" } },
        period: "5m",
        hasTushareToken: false,
      })
    ).toBe("binance_crypto");
  });
});

describe("isCryptoMarket integration", () => {
  test("BTCUSDT without exchange", () => {
    expect(isCryptoMarket("BTCUSDT", "")).toBe(true);
  });
});

describe("symbolToEastMoneySecId", () => {
  test("SH / SZ", () => {
    expect(symbolToEastMoneySecId("600000", "SH")).toBe("1.600000");
    expect(symbolToEastMoneySecId("000001", "SZ")).toBe("0.000001");
  });
});

describe("splitRangeForYahoo", () => {
  const D = 24 * 60 * 60 * 1000;

  test("invalid or empty window returns []", () => {
    expect(splitRangeForYahoo(Number.NaN, 100, D)).toEqual([]);
    expect(splitRangeForYahoo(100, Number.NaN, D)).toEqual([]);
    expect(splitRangeForYahoo(500, 500, D)).toEqual([]);
    expect(splitRangeForYahoo(500, 100, D)).toEqual([]);
  });

  test("window <= max returns single chunk", () => {
    expect(splitRangeForYahoo(0, 5 * D, 7 * D)).toEqual([{ startMs: 0, endMs: 5 * D }]);
    expect(splitRangeForYahoo(0, 7 * D, 7 * D)).toEqual([{ startMs: 0, endMs: 7 * D }]);
  });

  test("infinite or non-positive max returns single chunk", () => {
    expect(splitRangeForYahoo(0, 365 * D, Number.POSITIVE_INFINITY)).toEqual([
      { startMs: 0, endMs: 365 * D },
    ]);
    expect(splitRangeForYahoo(0, 365 * D, 0)).toEqual([{ startMs: 0, endMs: 365 * D }]);
  });

  test("splits oversized window into contiguous chunks", () => {
    const chunks = splitRangeForYahoo(0, 20 * D, 7 * D);
    expect(chunks).toEqual([
      { startMs: 0, endMs: 7 * D },
      { startMs: 7 * D, endMs: 14 * D },
      { startMs: 14 * D, endMs: 20 * D },
    ]);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startMs).toBe(chunks[i - 1].endMs);
    }
  });

  test("180d / 60d window for 60m-style cap", () => {
    const chunks = splitRangeForYahoo(0, 180 * D, 60 * D);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toEqual({ startMs: 0, endMs: 60 * D });
    expect(chunks[2].endMs).toBe(180 * D);
  });
});
