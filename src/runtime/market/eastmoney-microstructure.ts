import type {
  FetchOrderBookParams,
  FetchQuoteParams,
  FetchTradesParams,
  OrderBookData,
  OrderBookLevel,
  QuoteData,
  TradeData,
} from "../../connectors/data/data.connector";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { symbolToEastMoneySecId } from "./eastmoney-klines";
import { marketDataFetch } from "./market-data-network";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";
const QUOTE_URLS = [
  "https://push2.eastmoney.com/api/qt/stock/get",
  "https://push2delay.eastmoney.com/api/qt/stock/get",
] as const;
const TRADES_URLS = [
  "https://push2.eastmoney.com/api/qt/stock/details/get",
  "https://push2delay.eastmoney.com/api/qt/stock/details/get",
] as const;

type EastMoneyFieldValue = number | string | null | undefined;

interface EastMoneyQuoteResponse {
  rc?: number;
  data?: Record<string, EastMoneyFieldValue>;
}

interface EastMoneyTradesResponse {
  rc?: number;
  data?: {
    details?: string[];
  };
}

function finite(value: EastMoneyFieldValue): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function scaledPrice(value: EastMoneyFieldValue): number | undefined {
  const parsed = finite(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed;
}

function responseTimestamp(value: EastMoneyFieldValue): string {
  const epochSeconds = finite(value);
  if (epochSeconds !== undefined && epochSeconds > 0) {
    return new Date(epochSeconds * 1000).toISOString();
  }
  return new Date().toISOString();
}

async function fetchJson<T>(
  urls: readonly string[],
  settings: BuiltinConnectorInitConfigs
): Promise<T> {
  let lastError: unknown = null;
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await marketDataFetch("eastmoney", settings, url, {
          headers: {
            "User-Agent": UA,
            Accept: "application/json",
            Referer: "https://quote.eastmoney.com/",
          },
        });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(
            `eastmoney microstructure HTTP ${response.status}: ${text.slice(0, 160)}`
          );
        }
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`eastmoney microstructure invalid JSON: ${text.slice(0, 160)}`);
        }
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 200));
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function quoteFields(): string {
  return [
    "f43",
    "f44",
    "f45",
    "f46",
    "f47",
    "f48",
    "f57",
    "f58",
    "f60",
    "f86",
    "f19",
    "f20",
    "f17",
    "f18",
    "f15",
    "f16",
    "f13",
    "f14",
    "f11",
    "f12",
    "f39",
    "f40",
    "f37",
    "f38",
    "f35",
    "f36",
    "f33",
    "f34",
    "f31",
    "f32",
  ].join(",");
}

async function fetchQuotePayload(
  symbol: string,
  exchange: string,
  settings: BuiltinConnectorInitConfigs
): Promise<Record<string, EastMoneyFieldValue>> {
  const secid = symbolToEastMoneySecId(symbol, exchange);
  if (!secid) throw new Error("eastmoney: quote supports China A-share/BJ symbols only");
  const query = new URLSearchParams({
    secid,
    fields: quoteFields(),
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    fltt: "2",
    invt: "2",
  });
  const payload = await fetchJson<EastMoneyQuoteResponse>(
    QUOTE_URLS.map((base) => `${base}?${query.toString()}`),
    settings
  );
  if (payload.rc !== 0 || !payload.data) {
    throw new Error(`eastmoney quote unavailable: rc=${payload.rc ?? "unknown"}`);
  }
  return payload.data;
}

export async function fetchEastMoneyQuote(
  params: FetchQuoteParams,
  settings: BuiltinConnectorInitConfigs = {}
): Promise<QuoteData> {
  const data = await fetchQuotePayload(params.symbol, params.exchange ?? "", settings);
  const timestamp = responseTimestamp(data.f86);
  const lastPrice = scaledPrice(data.f43);
  if (lastPrice === undefined) throw new Error("eastmoney quote unavailable: missing last price");
  return {
    symbol: params.symbol,
    exchange: params.exchange || "UNKNOWN",
    source: "eastmoney",
    lastPrice,
    ...(scaledPrice(data.f46) !== undefined ? { open: scaledPrice(data.f46)! } : {}),
    ...(scaledPrice(data.f44) !== undefined ? { high: scaledPrice(data.f44)! } : {}),
    ...(scaledPrice(data.f45) !== undefined ? { low: scaledPrice(data.f45)! } : {}),
    ...(scaledPrice(data.f60) !== undefined
      ? { previousClose: scaledPrice(data.f60)! }
      : {}),
    ...(finite(data.f47) !== undefined ? { volume: finite(data.f47)! } : {}),
    ...(finite(data.f48) !== undefined ? { turnover: finite(data.f48)! } : {}),
    ...(scaledPrice(data.f19) !== undefined
      ? { bidPrice: scaledPrice(data.f19)! }
      : {}),
    ...(finite(data.f20) !== undefined ? { bidVolume: finite(data.f20)! } : {}),
    ...(scaledPrice(data.f39) !== undefined
      ? { askPrice: scaledPrice(data.f39)! }
      : {}),
    ...(finite(data.f40) !== undefined ? { askVolume: finite(data.f40)! } : {}),
    timestamp,
    freshnessMs: Math.max(0, Date.now() - Date.parse(timestamp)),
  };
}

const BID_FIELDS = [
  ["f19", "f20"],
  ["f17", "f18"],
  ["f15", "f16"],
  ["f13", "f14"],
  ["f11", "f12"],
] as const;
const ASK_FIELDS = [
  ["f39", "f40"],
  ["f37", "f38"],
  ["f35", "f36"],
  ["f33", "f34"],
  ["f31", "f32"],
] as const;

function levels(
  data: Record<string, EastMoneyFieldValue>,
  fields: ReadonlyArray<readonly [string, string]>,
  depth: number
): OrderBookLevel[] {
  const result: OrderBookLevel[] = [];
  for (const [priceField, volumeField] of fields.slice(0, depth)) {
    const price = scaledPrice(data[priceField]);
    const volume = finite(data[volumeField]);
    if (price === undefined || volume === undefined || volume < 0) continue;
    result.push({ price, volume });
  }
  return result;
}

export async function fetchEastMoneyOrderBook(
  params: FetchOrderBookParams,
  settings: BuiltinConnectorInitConfigs = {}
): Promise<OrderBookData> {
  const data = await fetchQuotePayload(params.symbol, params.exchange ?? "", settings);
  const depth = Math.max(1, Math.min(Math.floor(params.depth ?? 5), 5));
  const timestamp = responseTimestamp(data.f86);
  const bids = levels(data, BID_FIELDS, depth);
  const asks = levels(data, ASK_FIELDS, depth);
  return {
    symbol: params.symbol,
    exchange: params.exchange || "UNKNOWN",
    source: "eastmoney",
    bids,
    asks,
    timestamp,
    freshnessMs: Math.max(0, Date.now() - Date.parse(timestamp)),
  };
}

function tradeSide(value: string | undefined): TradeData["side"] {
  if (value === "2" || value?.toUpperCase() === "B") return "buy";
  if (value === "1" || value?.toUpperCase() === "S") return "sell";
  if (value === "4" || value?.toUpperCase() === "N") return "neutral";
  return "unknown";
}

function tradeTimestamp(raw: string, marketTimestamp?: string): string {
  const marketDate = new Date(marketTimestamp ?? Date.now()).toLocaleDateString("en-CA", {
    timeZone: "Asia/Shanghai",
  });
  const parsed = Date.parse(`${marketDate}T${raw}+08:00`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

export function parseEastMoneyTradeRow(
  row: string,
  params: FetchTradesParams,
  index: number,
  marketTimestamp?: string
): TradeData | null {
  const parts = row.split(",");
  if (parts.length < 3) return null;
  const time = parts[0]?.trim() ?? "";
  const price = Number(parts[1]);
  const volume = Number(parts[2]);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(volume) || volume < 0) return null;
  return {
    id: `eastmoney:${params.symbol}:${marketTimestamp?.slice(0, 10) ?? "current"}:${time}:${index}`,
    symbol: params.symbol,
    exchange: params.exchange || "UNKNOWN",
    source: "eastmoney",
    price,
    volume,
    side: tradeSide(parts[3]?.trim()),
    timestamp: tradeTimestamp(time, marketTimestamp),
  };
}

export async function fetchEastMoneyTrades(
  params: FetchTradesParams,
  settings: BuiltinConnectorInitConfigs = {}
): Promise<TradeData[]> {
  const secid = symbolToEastMoneySecId(params.symbol, params.exchange ?? "");
  if (!secid) throw new Error("eastmoney: trades support China A-share/BJ symbols only");
  const limit = Math.max(1, Math.min(Math.floor(params.limit ?? 50), 200));
  const query = new URLSearchParams({
    secid,
    fields1: "f1,f2,f3,f4",
    fields2: "f51,f52,f53,f54,f55",
    pos: String(-limit),
    iscca: "1",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
  });
  const [payload, quote] = await Promise.all([
    fetchJson<EastMoneyTradesResponse>(
      TRADES_URLS.map((base) => `${base}?${query.toString()}`),
      settings
    ),
    fetchQuotePayload(params.symbol, params.exchange ?? "", settings),
  ]);
  if (payload.rc !== 0) {
    throw new Error(`eastmoney trades unavailable: rc=${payload.rc ?? "unknown"}`);
  }
  const marketTimestamp = responseTimestamp(quote.f86);
  return (payload.data?.details ?? [])
    .map((row, index) =>
      parseEastMoneyTradeRow(row, params, index, marketTimestamp)
    )
    .filter((row): row is TradeData => row !== null);
}
