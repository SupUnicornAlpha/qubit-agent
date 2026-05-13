import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";

/** User-selectable K-line upstream (配置中心 `qubit-data.klinesDataSource`). */
export type KlinesDataSourceSetting = "auto" | "tushare_daily" | "yahoo_chart" | "synthetic";

/** Value exposed in `GET /market/klines` meta and used internally after resolution. */
export type KlinesDataSourceMeta = "tushare_daily" | "yahoo_chart" | "synthetic";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";

export function parseKlinesDataSourceSetting(raw: unknown): KlinesDataSourceSetting {
  if (raw === "tushare_daily" || raw === "yahoo_chart" || raw === "synthetic" || raw === "auto") {
    return raw;
  }
  return "auto";
}

function qubitDataSettings(settings: BuiltinConnectorInitConfigs): Record<string, unknown> {
  return (settings["qubit-data"] ?? {}) as Record<string, unknown>;
}

export function resolveEffectiveKlinesSource(params: {
  settings: BuiltinConnectorInitConfigs;
  period: FetchBarsParams["period"];
  hasTushareToken: boolean;
}): KlinesDataSourceMeta {
  const mode = parseKlinesDataSourceSetting(qubitDataSettings(params.settings).klinesDataSource);
  if (params.period !== "1d") {
    return "synthetic";
  }
  if (mode === "synthetic") return "synthetic";
  if (mode === "yahoo_chart") return "yahoo_chart";
  if (mode === "tushare_daily") {
    return params.hasTushareToken ? "tushare_daily" : "synthetic";
  }
  if (params.hasTushareToken) return "tushare_daily";
  return "yahoo_chart";
}

/** Tushare `600000.SH` → Yahoo `600000.SS`; 其它市场追加 Yahoo 后缀。 */
export function symbolToYahooSymbol(symbol: string, exchange: string): string {
  const s = symbol.trim().toUpperCase();
  const ex = exchange.trim().toUpperCase();
  if (!s) return s;
  if (s.includes(".")) {
    if (s.endsWith(".SH")) return `${s.slice(0, -3)}.SS`;
    return s;
  }
  const digits = s.replace(/\D/g, "").slice(-6).padStart(6, "0");
  const alnum = s.replace(/[^A-Z0-9]/gi, "");

  if (ex.includes("SH") || ex === "SSE" || ex === "XSHG") return `${digits}.SS`;
  if (ex.includes("SZ") || ex === "SZSE" || ex === "XSHE") return `${digits}.SZ`;
  if (ex.includes("HK") || ex === "HKEX") {
    const hkDigits = s.replace(/\D/g, "").slice(-5).padStart(5, "0");
    return `${hkDigits.slice(-4)}.HK`;
  }

  if (ex === "JP" || ex === "TSE" || ex === "TYO") {
    const n = s.replace(/\D/g, "");
    return n ? `${n}.T` : `${alnum}.T`;
  }
  if (ex === "UK" || ex === "LSE") {
    return alnum ? `${alnum}.L` : s;
  }
  if (ex === "DE" || ex === "XETRA" || ex === "GER") {
    return alnum ? `${alnum}.DE` : s;
  }
  if (ex === "FR" || ex === "EPA" || ex === "PAR") {
    return alnum ? `${alnum}.PA` : s;
  }
  if (ex === "CA" || ex === "TSX" || ex === "TO") {
    return alnum ? `${alnum}.TO` : s;
  }
  if (ex === "AU" || ex === "ASX") {
    return alnum ? `${alnum}.AX` : s;
  }
  if (ex === "KR" || ex === "KRX" || ex === "KOSPI") {
    const n = s.replace(/\D/g, "");
    return n ? `${n}.KS` : `${alnum}.KS`;
  }
  if (ex === "KQ" || ex === "KOSDAQ") {
    const n = s.replace(/\D/g, "");
    return n ? `${n}.KQ` : `${alnum}.KQ`;
  }
  if (ex === "TW" || ex === "TWSE") {
    const n = s.replace(/\D/g, "");
    return n ? `${n}.TW` : `${alnum}.TW`;
  }
  if (ex === "SG" || ex === "SGX") {
    return alnum ? `${alnum}.SI` : s;
  }
  if (ex === "IN" || ex === "NSE") {
    return alnum ? `${alnum}.NS` : s;
  }

  if (!ex || ex === "UNKNOWN") {
    if (/^\d{6}$/.test(s)) return `${s}.SS`;
    return s.length <= 5 ? s : `${digits}.SS`;
  }
  if (ex === "US" || ex === "NASDAQ" || ex === "NYSE" || ex === "AMEX" || ex === "OTC") {
    return s.length <= 5 ? s : `${digits}`;
  }
  return `${digits}.SS`;
}

interface YahooChartResponse {
  chart?: {
    error?: { description?: string };
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
}

export async function fetchYahooFinanceDailyBars(params: FetchBarsParams): Promise<BarData[]> {
  const ticker = symbolToYahooSymbol(params.symbol, params.exchange || "");
  if (!ticker) throw new Error("yahoo_chart: empty symbol");
  const startMs = Date.parse(params.startDate);
  const endMs = Date.parse(params.endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error("yahoo_chart: invalid date range");
  }
  const period1 = Math.floor(startMs / 1000);
  const period2 = Math.ceil(endMs / 1000) + 86_400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1}&period2=${period2}&interval=1d`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const json = (await res.json()) as YahooChartResponse;
  if (!res.ok) {
    throw new Error(`yahoo_chart: HTTP ${res.status}`);
  }
  const err = json.chart?.error;
  if (err?.description) {
    throw new Error(`yahoo_chart: ${err.description}`);
  }
  const result = json.chart?.result?.[0];
  const ts = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!result || !ts?.length || !quote) {
    return [];
  }
  const { open = [], high = [], low = [], close = [], volume = [] } = quote;
  const bars: BarData[] = [];
  for (let i = 0; i < ts.length; i += 1) {
    const o = open[i];
    const h = high[i];
    const lo = low[i];
    const c = close[i];
    if (o == null || h == null || lo == null || c == null) continue;
    const t = ts[i];
    if (typeof t !== "number") continue;
    bars.push({
      symbol: params.symbol,
      exchange: params.exchange || "UNKNOWN",
      open: o,
      high: h,
      low: lo,
      close: c,
      volume: Number(volume[i] ?? 0),
      turnover: 0,
      timestamp: new Date(t * 1000).toISOString(),
    });
  }
  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return bars;
}
