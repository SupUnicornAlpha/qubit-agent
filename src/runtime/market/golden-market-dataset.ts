import type { BarData } from "../../connectors/data/data.connector";
import type { MarketDataProvenance } from "./point-in-time-contract";

function bar(symbol: string, exchange: string, timestamp: string, close: number): BarData {
  return {
    symbol, exchange, timestamp,
    open: close - 1, high: close + 1, low: close - 2, close,
    volume: 1_000, turnover: close * 1_000,
  };
}

export const GOLDEN_MARKET_DATASET: Array<{
  id: string;
  market: "CN" | "US" | "HK";
  bars: BarData[];
  provenance: MarketDataProvenance;
  expectedValid: boolean;
  expectedError?: string;
}> = [
  {
    id: "us-active-valid", market: "US",
    bars: [bar("AAPL", "US", "2026-07-10T20:00:00.000Z", 200)],
    provenance: {
      provider: "golden", fetchedAt: "2026-07-11T00:00:00.000Z", dataAsof: "2026-07-10T23:59:59.000Z", adjustType: "post",
      security: { symbol: "AAPL", exchange: "US", listingStatus: "active", listedAt: "1980-12-12T00:00:00.000Z" },
    },
    expectedValid: true,
  },
  {
    id: "cn-future-bar", market: "CN",
    bars: [bar("600519", "SH", "2026-07-12T07:00:00.000Z", 1500)],
    provenance: {
      provider: "golden", fetchedAt: "2026-07-11T08:00:00.000Z", dataAsof: "2026-07-11T07:00:00.000Z", adjustType: "pre",
      security: { symbol: "600519", exchange: "SH", listingStatus: "active" },
    },
    expectedValid: false, expectedError: "future_bar",
  },
  {
    id: "hk-post-delist", market: "HK",
    bars: [bar("0700", "HK", "2026-07-10T08:00:00.000Z", 500)],
    provenance: {
      provider: "golden", fetchedAt: "2026-07-11T00:00:00.000Z", dataAsof: "2026-07-10T23:59:59.000Z", adjustType: "none",
      security: { symbol: "0700", exchange: "HK", listingStatus: "delisted", delistedAt: "2026-07-09T00:00:00.000Z" },
    },
    expectedValid: false, expectedError: "bar_after_delisting",
  },
  {
    id: "us-invalid-ohlc", market: "US",
    bars: [{ ...bar("MSFT", "US", "2026-07-10T20:00:00.000Z", 450), low: 460 }],
    provenance: {
      provider: "golden", fetchedAt: "2026-07-11T00:00:00.000Z", dataAsof: "2026-07-10T23:59:59.000Z", adjustType: "post",
      security: { symbol: "MSFT", exchange: "US", listingStatus: "active" },
    },
    expectedValid: false, expectedError: "invalid_ohlc",
  },
];
