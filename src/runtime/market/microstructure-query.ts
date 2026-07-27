import type {
  ChipDistributionData,
  FetchChipDistributionParams,
  FetchOrderBookParams,
  FetchQuoteParams,
  FetchTradesParams,
  OrderBookData,
  QuoteData,
  TradeData,
} from "../../connectors/data/data.connector";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import { fetchAkshareChipDistribution } from "./akshare-klines";
import {
  fetchBinanceOrderBook,
  fetchBinanceTicker,
  fetchBinanceTrades,
} from "./binance-klines";
import {
  fetchEastMoneyOrderBook,
  fetchEastMoneyQuote,
  fetchEastMoneyTrades,
} from "./eastmoney-microstructure";
import { resolveTickerMarket } from "./resolve-ticker-market";
import { fetchEastMoneyChipDistribution } from "./eastmoney-chip-distribution";

export async function queryMarketQuote(params: FetchQuoteParams): Promise<QuoteData> {
  const settings = await loadBuiltinConnectorSettings();
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  if (resolution.market === "CRYPTO") {
    const config = (settings["qubit-data"] ?? {}) as Record<string, unknown>;
    const ticker = await fetchBinanceTicker(params.symbol, params.exchange, config);
    return {
      symbol: params.symbol,
      exchange: params.exchange || "CRYPTO",
      source: "binance_crypto",
      ...ticker,
      freshnessMs: Math.max(0, Date.now() - Date.parse(ticker.timestamp)),
    };
  }
  if (resolution.market === "CN") return fetchEastMoneyQuote(params, settings);
  throw new Error(
    `market_data_unavailable: real-time quote source is not configured for market=${resolution.market}`
  );
}

export async function queryMarketOrderBook(
  params: FetchOrderBookParams
): Promise<OrderBookData> {
  const settings = await loadBuiltinConnectorSettings();
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  if (resolution.market === "CRYPTO") {
    return fetchBinanceOrderBook(
      params,
      (settings["qubit-data"] ?? {}) as Record<string, unknown>
    );
  }
  if (resolution.market === "CN") return fetchEastMoneyOrderBook(params, settings);
  throw new Error(
    `market_data_unavailable: order book source is not configured for market=${resolution.market}`
  );
}

export async function queryMarketTrades(params: FetchTradesParams): Promise<TradeData[]> {
  const settings = await loadBuiltinConnectorSettings();
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  if (resolution.market === "CRYPTO") {
    return fetchBinanceTrades(
      params,
      (settings["qubit-data"] ?? {}) as Record<string, unknown>
    );
  }
  if (resolution.market === "CN") return fetchEastMoneyTrades(params, settings);
  throw new Error(
    `market_data_unavailable: time-and-sales source is not configured for market=${resolution.market}`
  );
}

export async function queryChipDistribution(
  params: FetchChipDistributionParams
): Promise<ChipDistributionData[]> {
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  if (resolution.market !== "CN") {
    throw new Error("market_data_unavailable: chip distribution currently supports CN only");
  }
  const settings = await loadBuiltinConnectorSettings();
  try {
    return await fetchEastMoneyChipDistribution(params, settings);
  } catch (error) {
    try {
      return await fetchAkshareChipDistribution(params, settings);
    } catch {
      throw error;
    }
  }
}
