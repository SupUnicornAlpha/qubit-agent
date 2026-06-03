import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { fetchWithTimeout } from "../../util/fetch-with-timeout";
import type { BuiltinConnectorInitConfigs } from "../config/builtin-connector-settings";
import { isCryptoMarket } from "./crypto-market";
import { isChinaAShareMarket } from "./eastmoney-klines";
import { aggregateBarsByMsWindow } from "./klines-bars";
import { resolveTickerMarket } from "./resolve-ticker-market";

/** User-selectable K-line upstream (配置中心 `qubit-data.klinesDataSource`). */
export type KlinesDataSourceSetting =
  | "auto"
  | "tushare_daily"
  | "yahoo_chart"
  | "eastmoney"
  | "akshare"
  | "yfinance"
  | "binance_crypto"
  | "synthetic";

/** Value exposed in `GET /market/klines` meta and used internally after resolution. */
export type KlinesDataSourceMeta =
  | "tushare_daily"
  | "yahoo_chart"
  | "eastmoney"
  | "akshare"
  | "yfinance"
  | "binance_crypto"
  | "synthetic";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";

export function parseKlinesDataSourceSetting(raw: unknown): KlinesDataSourceSetting {
  if (
    raw === "tushare_daily" ||
    raw === "yahoo_chart" ||
    raw === "eastmoney" ||
    raw === "akshare" ||
    raw === "yfinance" ||
    raw === "binance_crypto" ||
    raw === "synthetic" ||
    raw === "auto"
  ) {
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
  symbol?: string;
  exchange?: string;
}): KlinesDataSourceMeta {
  const mode = parseKlinesDataSourceSetting(qubitDataSettings(params.settings).klinesDataSource);
  if (mode === "synthetic") return "synthetic";
  if (mode === "binance_crypto") return "binance_crypto";
  if (mode === "eastmoney") return "eastmoney";
  if (mode === "akshare") return "akshare";
  if (mode === "yfinance") return "yfinance";
  if (mode === "yahoo_chart") return "yahoo_chart";
  if (mode === "tushare_daily") {
    return params.hasTushareToken ? "tushare_daily" : "synthetic";
  }

  const crypto =
    params.symbol !== undefined
      ? isCryptoMarket(params.symbol, params.exchange ?? "")
      : false;
  const china =
    params.symbol !== undefined
      ? isChinaAShareMarket(params.symbol, params.exchange ?? "")
      : false;

  /** auto：加密 → Binance；日线有 Tushare token → Tushare；A 股/北交所 → 东方财富；否则 Yahoo */
  if (crypto) return "binance_crypto";
  if (params.period === "1d" && params.hasTushareToken) return "tushare_daily";
  if (china) return "eastmoney";
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
  if (ex === "NL" || ex === "AMS") {
    return alnum ? `${alnum}.AS` : s;
  }
  if (ex === "CH" || ex === "SIX") {
    return alnum ? `${alnum}.SW` : s;
  }
  if (ex === "IT" || ex === "MIL") {
    return alnum ? `${alnum}.MI` : s;
  }
  if (ex === "ES" || ex === "BME") {
    return alnum ? `${alnum}.MC` : s;
  }
  if (ex === "CRYPTO" || ex === "CC" || ex === "BINANCE") {
    if (/^[A-Z0-9]{2,12}-USD$/i.test(s)) return s.toUpperCase();
    const base = (alnum || "BTC").replace(/-USD$/i, "");
    if (base.includes("-")) return base.toUpperCase();
    return `${base.toUpperCase()}-USD`;
  }

  if (!ex || ex === "UNKNOWN") {
    /**
     * 评估报告 P0 修复点：之前 6 位数字一律 fallback `.SS`（沪市），
     * 把 `000001`（应为 .SZ 平安银行）错路到 `000001.SS`（上证综指）。
     * 现在按统一 resolver 推断（6→SH/.SS，0/3→SZ/.SZ，4/8→BJ）。
     */
    if (/^\d{6}$/.test(s)) {
      const r = resolveTickerMarket(s);
      if (r.market === "CN" && r.exchange === "SZ") return `${s}.SZ`;
      // BJ 在 Yahoo 上没有官方后缀，只能继续走沪市 fallback；调用方应优先走 eastmoney
      return `${s}.SS`;
    }
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

function parseYahooChartResultToBars(json: YahooChartResponse, params: FetchBarsParams): BarData[] {
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

async function fetchYahooChartJson(
  ticker: string,
  period1Sec: number,
  period2Sec: number,
  interval: string
): Promise<YahooChartResponse> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${period1Sec}&period2=${period2Sec}&interval=${encodeURIComponent(interval)}`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  const json = (await res.json()) as YahooChartResponse;
  if (!res.ok) {
    throw new Error(`yahoo_chart: HTTP ${res.status}`);
  }
  return json;
}

/** Yahoo Chart `interval`：4h 无原生档位，先拉 60m 再按 4h 桶合并 */
function yahooChartIntervalForPeriod(period: FetchBarsParams["period"]): string | null {
  switch (period) {
    case "1d":
      return "1d";
    case "1m":
      return "1m";
    case "5m":
      return "5m";
    case "15m":
      return "15m";
    case "30m":
      return "30m";
    case "1h":
      return "60m";
    case "4h":
      return "60m";
    default:
      return null;
  }
}

/**
 * Yahoo v8 chart 的非官方限制：每个 `interval` 都有"单次窗口"和"最远可回溯历史"。
 * 超出单次窗口直接拿到的数据会被截短；超出历史深度则该段时间根本不存在数据。
 * 这里的取值是社区/实测共识，留有一定裕量。
 */
interface YahooIntervalCaps {
  /** 单次 chart 调用允许的最大时间窗口（毫秒）。 */
  maxChunkMs: number;
  /** Yahoo 该 interval 能回溯的最远历史（毫秒）。 */
  maxHistoryMs: number;
}

const D_MS = 24 * 60 * 60 * 1000;
const YAHOO_INTERVAL_CAPS: Record<string, YahooIntervalCaps> = {
  "1m": { maxChunkMs: 7 * D_MS, maxHistoryMs: 30 * D_MS },
  "5m": { maxChunkMs: 60 * D_MS, maxHistoryMs: 60 * D_MS },
  "15m": { maxChunkMs: 60 * D_MS, maxHistoryMs: 60 * D_MS },
  "30m": { maxChunkMs: 60 * D_MS, maxHistoryMs: 60 * D_MS },
  "60m": { maxChunkMs: 60 * D_MS, maxHistoryMs: 730 * D_MS },
  "1d": { maxChunkMs: Number.POSITIVE_INFINITY, maxHistoryMs: Number.POSITIVE_INFINITY },
};

function getYahooIntervalCaps(interval: string): YahooIntervalCaps {
  return YAHOO_INTERVAL_CAPS[interval] ?? YAHOO_INTERVAL_CAPS["1d"];
}

/** 把 `[startMs, endMs)` 按最大窗口切成连续片段，输入非法则返回空数组。 */
export function splitRangeForYahoo(
  startMs: number,
  endMs: number,
  maxChunkMs: number
): Array<{ startMs: number; endMs: number }> {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }
  if (!Number.isFinite(maxChunkMs) || maxChunkMs <= 0 || endMs - startMs <= maxChunkMs) {
    return [{ startMs, endMs }];
  }
  const chunks: Array<{ startMs: number; endMs: number }> = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const next = Math.min(cursor + maxChunkMs, endMs);
    chunks.push({ startMs: cursor, endMs: next });
    cursor = next;
  }
  return chunks;
}

function dedupeBarsByTimestamp(bars: BarData[]): BarData[] {
  if (bars.length <= 1) return [...bars];
  const sorted = [...bars].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const out: BarData[] = [];
  let lastTs = "";
  for (const b of sorted) {
    if (b.timestamp === lastTs) continue;
    out.push(b);
    lastTs = b.timestamp;
  }
  return out;
}

/**
 * Yahoo Finance v8 chart：日线 + 分钟/小时（`1m`…`4h`）。
 *
 * 内部对 Yahoo 的"单次窗口"硬限做了透明分段：
 * - `1m`：每段 7 天，历史 30 天；`5m`/`15m`/`30m`：每段 60 天，历史 60 天；
 * - `60m`(对应 `1h`/`4h`)：每段 60 天，历史 730 天；`1d`：单次直拉。
 *
 * 起点超出 Yahoo 历史窗口时会被静默 clamp，避免发出注定为空的请求；
 * 单段失败不影响其它段。返回的 K 线会按时间戳去重并升序排列。
 */
export async function fetchYahooFinanceBars(params: FetchBarsParams): Promise<BarData[]> {
  const ticker = symbolToYahooSymbol(params.symbol, params.exchange || "");
  if (!ticker) throw new Error("yahoo_chart: empty symbol");
  const startMsRaw = Date.parse(params.startDate);
  const endMsRaw = Date.parse(params.endDate);
  if (!Number.isFinite(startMsRaw) || !Number.isFinite(endMsRaw)) {
    throw new Error("yahoo_chart: invalid date range");
  }

  const yahooIv = yahooChartIntervalForPeriod(params.period);
  if (!yahooIv) return [];

  const caps = getYahooIntervalCaps(yahooIv);
  const nowMs = Date.now();
  const minStartMs = Number.isFinite(caps.maxHistoryMs)
    ? nowMs - caps.maxHistoryMs
    : Number.NEGATIVE_INFINITY;
  const startMs = Math.max(startMsRaw, minStartMs);
  let endMs = endMsRaw;
  if (params.period === "1d") {
    endMs += D_MS;
  }
  if (endMs <= startMs) return [];

  const chunks = splitRangeForYahoo(startMs, endMs, caps.maxChunkMs);
  const merged: BarData[] = [];
  let lastChunkError: unknown;
  for (const c of chunks) {
    const p1 = Math.floor(c.startMs / 1000);
    const p2 = Math.ceil(c.endMs / 1000);
    try {
      const json = await fetchYahooChartJson(ticker, p1, p2, yahooIv);
      const bars = parseYahooChartResultToBars(json, params);
      if (bars.length > 0) merged.push(...bars);
    } catch (e) {
      lastChunkError = e;
      console.warn(
        `[yahoo_chart] chunk ${new Date(c.startMs).toISOString()}..${new Date(c.endMs).toISOString()} failed (${ticker}, ${yahooIv})`,
        e instanceof Error ? e.message : e
      );
    }
  }

  if (merged.length === 0 && lastChunkError && chunks.length === 1) {
    throw lastChunkError;
  }

  let bars = dedupeBarsByTimestamp(merged);
  if (params.period === "4h") {
    bars = aggregateBarsByMsWindow(
      bars,
      4 * 60 * 60 * 1000,
      params.symbol,
      params.exchange || "UNKNOWN"
    );
  }
  return bars;
}
