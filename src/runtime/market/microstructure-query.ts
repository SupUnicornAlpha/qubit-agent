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
import { fetchBinanceOrderBook, fetchBinanceTicker, fetchBinanceTrades } from "./binance-klines";
import { fetchEastMoneyChipDistribution } from "./eastmoney-chip-distribution";
import {
  fetchEastMoneyOrderBook,
  fetchEastMoneyQuote,
  fetchEastMoneyTrades,
} from "./eastmoney-microstructure";
import { fetchYahooDelayedQuote } from "./klines-data-source";
import { recordMarketDataSourceAttempt } from "./market-data-source-control";
import { resolveTickerMarket } from "./resolve-ticker-market";
import { fetchTencentQuote } from "./tencent-quote";

export async function queryMarketQuote(params: FetchQuoteParams): Promise<QuoteData> {
  const settings = await loadBuiltinConnectorSettings();
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  const normalizedParams = {
    ...params,
    exchange: params.exchange || resolution.exchange,
  };
  if (resolution.market === "CRYPTO") {
    const config = (settings["qubit-data"] ?? {}) as Record<string, unknown>;
    const started = Date.now();
    try {
      const ticker = await fetchBinanceTicker(
        normalizedParams.symbol,
        normalizedParams.exchange,
        config
      );
      await recordMarketDataSourceAttempt({
        sourceId: "binance_crypto",
        market: "CRYPTO",
        timeframe: "quote",
        symbol: params.symbol,
        status: "success",
        latencyMs: Date.now() - started,
      });
      return {
        symbol: params.symbol,
        exchange: params.exchange || "CRYPTO",
        source: "binance_crypto",
        ...ticker,
        freshnessMs: Math.max(0, Date.now() - Date.parse(ticker.timestamp)),
      };
    } catch (error) {
      await recordMarketDataSourceAttempt({
        sourceId: "binance_crypto",
        market: "CRYPTO",
        timeframe: "quote",
        symbol: params.symbol,
        status: "error",
        latencyMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  if (resolution.market === "CN") {
    const failures: string[] = [];
    const attempts = [
      {
        sourceId: "eastmoney" as const,
        fetch: () => fetchEastMoneyQuote(normalizedParams, settings),
      },
      {
        sourceId: "akshare_tencent" as const,
        fetch: () => fetchTencentQuote(normalizedParams, settings),
      },
    ];
    for (const attempt of attempts) {
      const started = Date.now();
      try {
        const quote = await attempt.fetch();
        await recordMarketDataSourceAttempt({
          sourceId: attempt.sourceId,
          market: "CN",
          timeframe: "quote",
          symbol: params.symbol,
          status: "success",
          latencyMs: Date.now() - started,
        });
        return quote;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${attempt.sourceId}: ${message}`);
        await recordMarketDataSourceAttempt({
          sourceId: attempt.sourceId,
          market: "CN",
          timeframe: "quote",
          symbol: params.symbol,
          status: "error",
          latencyMs: Date.now() - started,
          error: message,
        });
      }
    }
    throw new Error(`market_data_unavailable: realtime CN quote failed: ${failures.join(" | ")}`);
  }

  // US / HK / global equities: delayed last price when broker WS is unavailable.
  const started = Date.now();
  try {
    const quote = await fetchYahooDelayedQuote(normalizedParams, settings);
    await recordMarketDataSourceAttempt({
      sourceId: "yahoo_chart",
      market: resolution.market,
      timeframe: "quote",
      symbol: params.symbol,
      status: "success",
      latencyMs: Date.now() - started,
    });
    return quote;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordMarketDataSourceAttempt({
      sourceId: "yahoo_chart",
      market: resolution.market,
      timeframe: "quote",
      symbol: params.symbol,
      status: "error",
      latencyMs: Date.now() - started,
      error: message,
    });
    throw new Error(
      `market_data_unavailable: delayed quote failed for market=${resolution.market}: ${message}`
    );
  }
}

export async function queryMarketOrderBook(params: FetchOrderBookParams): Promise<OrderBookData> {
  const settings = await loadBuiltinConnectorSettings();
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  if (resolution.market === "CRYPTO") {
    return fetchBinanceOrderBook(params, (settings["qubit-data"] ?? {}) as Record<string, unknown>);
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
    return fetchBinanceTrades(params, (settings["qubit-data"] ?? {}) as Record<string, unknown>);
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
