import { describe, expect, test } from "bun:test";
import { isCryptoMarket, symbolToBinancePair, symbolToCcxtPair } from "./crypto-market";

describe("isCryptoMarket", () => {
  test("exchange CRYPTO", () => {
    expect(isCryptoMarket("BTC", "CRYPTO")).toBe(true);
    expect(isCryptoMarket("AAPL", "US")).toBe(false);
  });

  test("symbol patterns", () => {
    expect(isCryptoMarket("BTCUSDT", "")).toBe(true);
    expect(isCryptoMarket("ETH/USD", "")).toBe(true);
  });
});

describe("symbolToBinancePair", () => {
  test("normalizes common inputs", () => {
    expect(symbolToBinancePair("BTC", "CRYPTO")).toBe("BTCUSDT");
    expect(symbolToBinancePair("BTCUSDT", "CRYPTO")).toBe("BTCUSDT");
    expect(symbolToBinancePair("ETH/USD", "CRYPTO")).toBe("ETHUSDT");
    expect(symbolToBinancePair("BTC-USD", "CRYPTO")).toBe("BTCUSDT");
  });
});

describe("symbolToCcxtPair", () => {
  test("slash format", () => {
    expect(symbolToCcxtPair("BTCUSDT", "CRYPTO")).toBe("BTC/USDT");
  });
});
