import type { FetchQuoteParams, QuoteData } from "../../connectors/data/data.connector";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { marketDataFetch } from "./market-data-network";
import { resolveTickerMarket } from "./resolve-ticker-market";

const TENCENT_QUOTE_ENDPOINT = "https://qt.gtimg.cn/q=";

function tencentTicker(params: FetchQuoteParams): string {
  const resolution = resolveTickerMarket(params.symbol, { hintExchange: params.exchange });
  if (resolution.market !== "CN" || !["SH", "SZ"].includes(resolution.exchange)) {
    throw new Error("tencent quote supports Shanghai/Shenzhen A-shares only");
  }
  const code = params.symbol.replace(/\D/g, "").slice(-6);
  if (code.length !== 6) throw new Error("tencent quote: invalid A-share symbol");
  return `${resolution.exchange.toLowerCase()}${code}`;
}

function parseTencentTimestamp(raw: string): string {
  if (!/^\d{14}$/.test(raw)) throw new Error("tencent quote: missing market timestamp");
  const local = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(
    8,
    10
  )}:${raw.slice(10, 12)}:${raw.slice(12, 14)}+08:00`;
  const parsed = new Date(local);
  if (!Number.isFinite(parsed.getTime())) throw new Error("tencent quote: invalid timestamp");
  return parsed.toISOString();
}

export function parseTencentQuotePayload(text: string, params: FetchQuoteParams): QuoteData {
  const quoted = text.match(/="([^"]+)"/)?.[1];
  if (!quoted) throw new Error(`tencent quote: invalid response ${text.slice(0, 120)}`);
  const fields = quoted.split("~");
  const lastPrice = Number(fields[3]);
  const previousClose = Number(fields[4]);
  const open = Number(fields[5]);
  const volumeLots = Number(fields[6]);
  const high = Number(fields[33]);
  const low = Number(fields[34]);
  if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
    throw new Error("tencent quote: missing last price");
  }
  const timestamp = parseTencentTimestamp(fields[30] ?? "");
  return {
    symbol: params.symbol,
    exchange: resolveTickerMarket(params.symbol, { hintExchange: params.exchange }).exchange,
    source: "tencent",
    lastPrice,
    ...(Number.isFinite(open) ? { open } : {}),
    ...(Number.isFinite(high) ? { high } : {}),
    ...(Number.isFinite(low) ? { low } : {}),
    ...(Number.isFinite(previousClose) ? { previousClose } : {}),
    ...(Number.isFinite(volumeLots) ? { volume: volumeLots * 100 } : {}),
    timestamp,
    freshnessMs: Math.max(0, Date.now() - Date.parse(timestamp)),
  };
}

export async function fetchTencentQuote(
  params: FetchQuoteParams,
  settings: BuiltinConnectorInitConfigs = {}
): Promise<QuoteData> {
  const ticker = tencentTicker(params);
  const response = await marketDataFetch(
    "akshare_tencent",
    settings,
    `${TENCENT_QUOTE_ENDPOINT}${ticker}`,
    {
      headers: {
        Accept: "text/plain,*/*",
        Referer: "https://gu.qq.com/",
        "User-Agent": "Mozilla/5.0 (compatible; QubitAgent/1.0)",
      },
    }
  );
  if (!response.ok) throw new Error(`tencent quote: HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const text = new TextDecoder("gb18030" as ConstructorParameters<typeof TextDecoder>[0]).decode(
    buffer
  );
  return parseTencentQuotePayload(text, params);
}
