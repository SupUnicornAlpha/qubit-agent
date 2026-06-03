import type { BarData, FetchBarsParams } from "../../connectors/data/data.connector";
import { fetchWithTimeout } from "../../util/fetch-with-timeout";
import { aggregateBarsByMsWindow } from "./klines-bars";
import { resolveTickerMarket } from "./resolve-ticker-market";

const UA = "Mozilla/5.0 (compatible; QubitAgent/1.0; +https://github.com/)";
const EM_KLINE_URL = "https://push2his.eastmoney.com/api/qt/stock/kline/get";

interface EastMoneyKlineResponse {
  rc?: number;
  data?: {
    klines?: string[];
  };
}

/** 是否可走东方财富 A 股/北交所行情（免费、国内网络友好）。 */
export function isChinaAShareMarket(symbol: string, exchange: string): boolean {
  const s = symbol.trim().toUpperCase();
  const ex = exchange.trim().toUpperCase();
  if (!s) return false;
  if (s.endsWith(".SH") || s.endsWith(".SZ") || s.endsWith(".BJ")) return true;
  if (ex.includes("SH") || ex === "SSE" || ex === "XSHG") return true;
  if (ex.includes("SZ") || ex === "SZSE" || ex === "XSHE") return true;
  if (ex.includes("BJ") || ex === "BSE") return true;
  if (/^\d{6}$/.test(s.replace(/\D/g, "").slice(-6))) return true;
  return false;
}

/** 东方财富 `secid`：`1.600000`（沪）、`0.000001`（深）、北交所 `0.8xxxxx`。 */
export function symbolToEastMoneySecId(symbol: string, exchange: string): string | null {
  const s = symbol.trim().toUpperCase();
  const ex = exchange.trim().toUpperCase();
  if (!s) return null;

  let code = s;
  if (s.includes(".")) {
    const [c, suffix] = s.split(".", 2);
    code = c ?? s;
    const suf = (suffix ?? "").toUpperCase();
    if (suf === "SH" || suf === "SS") return `1.${code.replace(/\D/g, "").slice(-6).padStart(6, "0")}`;
    if (suf === "SZ") return `0.${code.replace(/\D/g, "").slice(-6).padStart(6, "0")}`;
    if (suf === "BJ") {
      const bj = code.replace(/\D/g, "");
      return `0.${bj}`;
    }
    return null;
  }

  const digits = s.replace(/\D/g, "").slice(-6).padStart(6, "0");
  if (ex.includes("BJ") || ex === "BSE" || digits.startsWith("8") || digits.startsWith("4")) {
    return `0.${digits}`;
  }
  if (ex.includes("SZ") || ex === "SZSE" || ex === "XSHE") return `0.${digits}`;
  if (ex.includes("SH") || ex === "SSE" || ex === "XSHG") return `1.${digits}`;

  /**
   * exchange 缺省（空 / "UNKNOWN" / 其它非 A 股 hint）→ 走统一 resolver。
   *
   * 评估报告 P0 修复点：之前这里一律 fallback 到 `1.${digits}`（沪市），
   * 导致 `000001`（应为深市 0.000001 平安银行）被路由到 `1.000001`（上证综指）；
   * 现在按 ticker 首位精确判断（6→SH，0/3→SZ，4/8→BJ），与 resolver 单一事实源对齐。
   */
  if (/^\d{6}$/.test(digits)) {
    const r = resolveTickerMarket(digits);
    if (r.market === "CN") {
      if (r.exchange === "SH") return `1.${digits}`;
      if (r.exchange === "SZ") return `0.${digits}`;
      if (r.exchange === "BJ") return `0.${digits}`;
    }
    // resolver 没识别但还是 6 位数字 → 留沪市兜底（与历史一致，且 explicit 上层不会进到这里）
    return `1.${digits}`;
  }
  return null;
}

function parseIsoToYmd(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.replace(/-/g, "").slice(0, 8);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/** 东方财富 klt：101 日 / 1·5·15·30·60 分钟 */
function eastMoneyKltForPeriod(period: FetchBarsParams["period"]): string | null {
  switch (period) {
    case "1d":
      return "101";
    case "1m":
      return "1";
    case "5m":
      return "5";
    case "15m":
      return "15";
    case "30m":
      return "30";
    case "1h":
      return "60";
    case "4h":
      return "60";
    default:
      return null;
  }
}

function parseEastMoneyKlineRow(
  row: string,
  params: FetchBarsParams
): BarData | null {
  const parts = row.split(",");
  if (parts.length < 6) return null;
  const dateRaw = parts[0]?.trim() ?? "";
  const open = Number(parts[1]);
  const close = Number(parts[2]);
  const high = Number(parts[3]);
  const low = Number(parts[4]);
  const volume = Number(parts[5]);
  const turnover = parts.length > 6 ? Number(parts[6]) : 0;
  if (![open, close, high, low].every(Number.isFinite)) return null;

  const ts = dateRaw.includes(" ")
    ? new Date(dateRaw.replace(" ", "T") + ":00+08:00").toISOString()
    : new Date(`${dateRaw.slice(0, 10)}T00:00:00+08:00`).toISOString();

  return {
    symbol: params.symbol,
    exchange: params.exchange || "UNKNOWN",
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    turnover: Number.isFinite(turnover) ? turnover : 0,
    timestamp: ts,
  };
}

async function fetchEastMoneyKlineJson(
  secid: string,
  klt: string,
  beg: string,
  end: string,
  lmt: number
): Promise<EastMoneyKlineResponse> {
  const qs = new URLSearchParams({
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    beg,
    end,
    klt,
    fqt: "1",
    secid,
    lmt: String(Math.min(Math.max(lmt, 1), 5000)),
  });
  const url = `${EM_KLINE_URL}?${qs.toString()}`;
  const res = await fetchWithTimeout(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://quote.eastmoney.com/",
    },
  });
  const json = (await res.json()) as EastMoneyKlineResponse;
  if (!res.ok) {
    throw new Error(`eastmoney: HTTP ${res.status}`);
  }
  if (json.rc !== 0) {
    throw new Error(`eastmoney: rc=${json.rc ?? "unknown"}`);
  }
  return json;
}

/**
 * 东方财富 K 线（免费、无需 API Key，A 股/北交所日线 + 分钟/小时）。
 * 非 A 股市场请使用 Yahoo / Tushare。
 */
export async function fetchEastMoneyBars(params: FetchBarsParams): Promise<BarData[]> {
  const secid = symbolToEastMoneySecId(params.symbol, params.exchange || "");
  if (!secid) throw new Error("eastmoney: unsupported symbol/exchange for A-share market");

  const klt = eastMoneyKltForPeriod(params.period);
  if (!klt) return [];

  const startMs = Date.parse(params.startDate);
  const endMs = Date.parse(params.endDate);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error("eastmoney: invalid date range");
  }

  const beg = parseIsoToYmd(params.startDate);
  const end = parseIsoToYmd(params.endDate);
  const daySpan = Math.max(1, Math.ceil((endMs - startMs) / 86_400_000));
  const lmt =
    params.period === "1d"
      ? Math.min(daySpan + 30, 5000)
      : Math.min(Math.ceil(daySpan * 80), 5000);

  const json = await fetchEastMoneyKlineJson(secid, klt, beg, end, lmt);
  const rows = json.data?.klines ?? [];
  let bars: BarData[] = [];
  for (const row of rows) {
    const b = parseEastMoneyKlineRow(row, params);
    if (b) bars.push(b);
  }
  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  bars = bars.filter((b) => b.timestamp >= startIso && b.timestamp <= endIso);

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
