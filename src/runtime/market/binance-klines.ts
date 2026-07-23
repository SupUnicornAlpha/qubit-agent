import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { isCryptoMarket, symbolToBinancePair } from "./crypto-market";
import { marketDataFetch } from "./market-data-network";

const DEFAULT_BASE = "https://data-api.binance.vision";
const TESTNET_BASE = "https://testnet.binance.vision";

function periodToBinanceInterval(period: FetchBarsParams["period"]): string {
  const map: Record<string, string> = {
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "30m": "30m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
    "1w": "1w",
  };
  return map[period] ?? "1d";
}

function resolveBinanceBaseUrl(settings?: Record<string, unknown>): string {
  const useTestnet = settings?.cryptoUseTestnet === true || settings?.cryptoUseTestnet === "true";
  const custom =
    typeof settings?.cryptoBinanceBaseUrl === "string" ? settings.cryptoBinanceBaseUrl.trim() : "";
  if (custom) return custom.replace(/\/$/, "");
  return useTestnet ? TESTNET_BASE : DEFAULT_BASE;
}

function networkSettings(settings?: Record<string, unknown>) {
  return { "qubit-data": settings ?? {} };
}

type BinanceKlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

/**
 * Binance 公开 K 线 API（无需 API Key）。适用于现货 USDT 交易对。
 */
export async function fetchBinanceBars(
  params: FetchBarsParams,
  settings?: Record<string, unknown>
): Promise<BarData[]> {
  if (!isCryptoMarket(params.symbol, params.exchange)) {
    throw new Error("fetchBinanceBars: not a crypto symbol");
  }

  const baseUrl = resolveBinanceBaseUrl(settings);
  const pair = symbolToBinancePair(params.symbol, params.exchange);
  const interval = periodToBinanceInterval(params.period);
  const startMs = Date.parse(params.startDate);
  const endMs = Date.parse(params.endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error("fetchBinanceBars: invalid date range");
  }

  const limit = Math.min(1000, Math.max(10, Math.ceil((endMs - startMs) / 60_000)));
  const url = new URL(`${baseUrl}/api/v3/klines`);
  url.searchParams.set("symbol", pair);
  url.searchParams.set("interval", interval);
  url.searchParams.set("startTime", String(startMs));
  url.searchParams.set("endTime", String(endMs));
  url.searchParams.set("limit", String(limit));

  const res = await marketDataFetch("binance_crypto", networkSettings(settings), url.toString(), {
    headers: { Accept: "application/json", "User-Agent": "QubitAgent/1.0" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`binance klines HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  let rows: BinanceKlineRow[];
  try {
    rows = JSON.parse(text) as BinanceKlineRow[];
  } catch {
    throw new Error("binance klines: invalid JSON");
  }

  if (!Array.isArray(rows)) return [];

  const bars: BarData[] = [];
  for (const row of rows) {
    const openTime = row[0];
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (!Number.isFinite(open) || !Number.isFinite(close)) continue;
    bars.push({
      symbol: params.symbol,
      exchange: params.exchange || "CRYPTO",
      open,
      high,
      low,
      close,
      volume: Number.isFinite(volume) ? volume : 0,
      turnover: Number(row[7]) || 0,
      timestamp: new Date(openTime).toISOString(),
    });
  }

  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return bars;
}

/** 24h ticker 价格（用于 fetch_ticks） */
export async function fetchBinanceTicker(
  symbol: string,
  exchange?: string,
  settings?: Record<string, unknown>
): Promise<{
  lastPrice: number;
  bidPrice: number;
  askPrice: number;
  volume: number;
  timestamp: string;
}> {
  const baseUrl = resolveBinanceBaseUrl(settings);
  const pair = symbolToBinancePair(symbol, exchange);
  const url = `${baseUrl}/api/v3/ticker/bookTicker?symbol=${encodeURIComponent(pair)}`;
  const res = await marketDataFetch("binance_crypto", networkSettings(settings), url, { headers: { Accept: "application/json" } });
  const json = (await res.json()) as {
    symbol?: string;
    bidPrice?: string;
    askPrice?: string;
  };
  if (!res.ok) {
    throw new Error(`binance bookTicker HTTP ${res.status}`);
  }
  const bid = Number(json.bidPrice ?? 0);
  const ask = Number(json.askPrice ?? 0);
  const last = bid && ask ? (bid + ask) / 2 : bid || ask;

  const statUrl = `${baseUrl}/api/v3/ticker/24hr?symbol=${encodeURIComponent(pair)}`;
  const statRes = await marketDataFetch("binance_crypto", networkSettings(settings), statUrl);
  const stat = (await statRes.json()) as { volume?: string; lastPrice?: string };
  const volume = Number(stat.volume ?? 0);
  const lastFromStat = Number(stat.lastPrice ?? 0);

  return {
    lastPrice: lastFromStat > 0 ? lastFromStat : last,
    bidPrice: bid,
    askPrice: ask,
    volume: Number.isFinite(volume) ? volume : 0,
    timestamp: new Date().toISOString(),
  };
}
