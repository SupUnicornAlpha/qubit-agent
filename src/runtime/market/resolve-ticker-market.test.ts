import { describe, expect, test } from "bun:test";
import { formatMarketResolution, resolveTickerMarket } from "./resolve-ticker-market";

describe("resolveTickerMarket — explicit suffix", () => {
  test(".SH / .SS → CN/SH explicit", () => {
    const r = resolveTickerMarket("600519.SH");
    expect(r.market).toBe("CN");
    expect(r.exchange).toBe("SH");
    expect(r.confidence).toBe("explicit");
  });
  test(".SZ → CN/SZ explicit", () => {
    expect(resolveTickerMarket("000001.SZ").exchange).toBe("SZ");
  });
  test(".BJ → CN/BJ explicit", () => {
    const r = resolveTickerMarket("872925.BJ");
    expect(r.market).toBe("CN");
    expect(r.exchange).toBe("BJ");
  });
  test(".HK → HK/HK explicit", () => {
    const r = resolveTickerMarket("00700.HK");
    expect(r.market).toBe("HK");
    expect(r.exchange).toBe("HK");
    expect(r.confidence).toBe("explicit");
  });
  test(".T → JP/TYO", () => {
    expect(resolveTickerMarket("7203.T").market).toBe("JP");
  });
  test(".L → UK/LSE", () => {
    expect(resolveTickerMarket("BARC.L").market).toBe("UK");
  });
  test("explicit suffix wins over hintExchange", () => {
    const r = resolveTickerMarket("000001.SH", { hintExchange: "SZ" });
    expect(r.exchange).toBe("SH");
    expect(r.confidence).toBe("explicit");
    expect(r.reason).toMatch(/explicit suffix/);
  });
});

describe("resolveTickerMarket — hintExchange explicit", () => {
  test("NASDAQ → US/US explicit", () => {
    const r = resolveTickerMarket("AAPL", { hintExchange: "NASDAQ" });
    expect(r.market).toBe("US");
    expect(r.confidence).toBe("explicit");
  });
  test("CRYPTO → CRYPTO explicit", () => {
    const r = resolveTickerMarket("BTC", { hintExchange: "CRYPTO" });
    expect(r.market).toBe("CRYPTO");
    expect(r.confidence).toBe("explicit");
  });
  test("HKEX → HK/HK explicit", () => {
    expect(resolveTickerMarket("700", { hintExchange: "HKEX" }).market).toBe("HK");
  });
  test("UNKNOWN hint 不视为显式", () => {
    const r = resolveTickerMarket("AAPL", { hintExchange: "UNKNOWN" });
    expect(r.confidence).toBe("inferred");
  });
});

describe("resolveTickerMarket — A-share 6-digit 修复 000001 错路 bug", () => {
  test("600519 → SH inferred (head 6)", () => {
    const r = resolveTickerMarket("600519");
    expect(r.market).toBe("CN");
    expect(r.exchange).toBe("SH");
    expect(r.confidence).toBe("inferred");
    expect(r.reason).toMatch(/leading 6/);
  });
  test("000001 → SZ inferred (head 0) — 平安银行不再被错路到上证综指", () => {
    const r = resolveTickerMarket("000001");
    expect(r.market).toBe("CN");
    expect(r.exchange).toBe("SZ");
    expect(r.reason).toMatch(/leading 0/);
  });
  test("300750 → SZ inferred (head 3, 创业板)", () => {
    expect(resolveTickerMarket("300750").exchange).toBe("SZ");
  });
  test("688981 → SH inferred (head 6, 科创板)", () => {
    expect(resolveTickerMarket("688981").exchange).toBe("SH");
  });
  test("872925 → BJ inferred (head 8)", () => {
    expect(resolveTickerMarket("872925").exchange).toBe("BJ");
  });
  test("430047 → BJ inferred (head 4)", () => {
    expect(resolveTickerMarket("430047").exchange).toBe("BJ");
  });
  test("510300 → SH fallback (ETF, head 5)", () => {
    expect(resolveTickerMarket("510300").exchange).toBe("SH");
  });
});

describe("resolveTickerMarket — crypto", () => {
  test("BTCUSDT", () => {
    const r = resolveTickerMarket("BTCUSDT");
    expect(r.market).toBe("CRYPTO");
    expect(r.confidence).toBe("inferred");
  });
  test("ETH/USD slash", () => {
    expect(resolveTickerMarket("ETH/USD").market).toBe("CRYPTO");
  });
  test("BTC-USD dash", () => {
    expect(resolveTickerMarket("BTC-USD").market).toBe("CRYPTO");
  });
  test("ETHBTC pair", () => {
    expect(resolveTickerMarket("ETHBTC").market).toBe("CRYPTO");
  });
  test("USD（短字母）不被误判为 crypto", () => {
    expect(resolveTickerMarket("USD").market).toBe("US");
  });
});

describe("resolveTickerMarket — HK short numeric", () => {
  test("0700 → HK", () => {
    const r = resolveTickerMarket("0700");
    expect(r.market).toBe("HK");
    expect(r.symbol).toBe("00700");
  });
  test("700 → HK padded", () => {
    expect(resolveTickerMarket("700").symbol).toBe("00700");
  });
});

describe("resolveTickerMarket — short US ticker", () => {
  test.each([
    ["AAPL"],
    ["TSLA"],
    ["MSFT"],
    ["F"],
    ["BRKB"],
  ])("%s → US inferred", (sym) => {
    const r = resolveTickerMarket(sym);
    expect(r.market).toBe("US");
    expect(r.exchange).toBe("US");
    expect(r.confidence).toBe("inferred");
  });
});

describe("resolveTickerMarket — Yahoo index/futures symbols", () => {
  test.each([["^VIX"], ["^GSPC"], ["GC=F"]])("%s → US inferred", (symbol) => {
    const result = resolveTickerMarket(symbol);
    expect(result.market).toBe("US");
    expect(result.exchange).toBe("US");
  });
});

describe("resolveTickerMarket — UNKNOWN fallback", () => {
  test("空字符串 → UNKNOWN fallback", () => {
    const r = resolveTickerMarket("");
    expect(r.market).toBe("UNKNOWN");
    expect(r.confidence).toBe("fallback");
  });
  test("纯空白 → UNKNOWN fallback", () => {
    expect(resolveTickerMarket("   ").market).toBe("UNKNOWN");
  });
  test("长字母数字混合（如 XYZ123456）→ UNKNOWN fallback", () => {
    const r = resolveTickerMarket("XYZ123456");
    expect(r.market).toBe("UNKNOWN");
    expect(r.confidence).toBe("fallback");
  });
});

describe("formatMarketResolution", () => {
  test("人类可读单行串", () => {
    const r = resolveTickerMarket("000001");
    const s = formatMarketResolution(r);
    expect(s).toMatch(/market=CN\/SZ/);
    expect(s).toMatch(/confidence=inferred/);
    expect(s).toMatch(/leading 0/);
  });
});
