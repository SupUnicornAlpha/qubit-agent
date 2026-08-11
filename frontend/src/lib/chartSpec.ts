import type { CSSProperties } from "react";

/** 全局 K 线请求参数（研究工作台工具条与 K 线面板共用） */
export interface ChartSpec {
  symbol: string;
  exchange: string;
  timeframe: string;
  limit: number;
}

export const DEFAULT_CHART_SPEC: ChartSpec = {
  symbol: "600000",
  exchange: "SH",
  timeframe: "1d",
  limit: 120,
};

export const CHART_TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"] as const;

export const CHART_CONTROL_WIDTH_PX = 132;

export type ChartMarketOption = { value: string; label: string };

export type ChartMarketGroup = { label: string; options: ChartMarketOption[] };

/** 全球市场分组（与后端 `symbolToYahooSymbol` / Eastmoney 路由对齐） */
export const CHART_MARKET_GROUPS: ChartMarketGroup[] = [
  {
    label: "中国大陆",
    options: [
      { value: "SH", label: "上交所 A" },
      { value: "SZ", label: "深交所 A" },
      { value: "BJ", label: "北交所" },
    ],
  },
  {
    label: "港澳台",
    options: [{ value: "HK", label: "港交所" }],
  },
  {
    label: "北美",
    options: [
      { value: "US", label: "美股" },
      { value: "CA", label: "加拿大" },
    ],
  },
  {
    label: "欧洲",
    options: [
      { value: "UK", label: "英国" },
      { value: "DE", label: "德国" },
      { value: "FR", label: "法国" },
      { value: "NL", label: "荷兰" },
      { value: "CH", label: "瑞士" },
      { value: "IT", label: "意大利" },
      { value: "ES", label: "西班牙" },
    ],
  },
  {
    label: "亚太",
    options: [
      { value: "JP", label: "日本" },
      { value: "KR", label: "韩国主板" },
      { value: "KQ", label: "韩国创业板" },
      { value: "TW", label: "台湾" },
      { value: "SG", label: "新加坡" },
      { value: "AU", label: "澳大利亚" },
      { value: "IN", label: "印度" },
    ],
  },
  {
    label: "衍生品",
    options: [
      { value: "CME", label: "期货（CME / Yahoo 连续合约）" },
      { value: "OPRA", label: "美股期权（OPRA，合约链）" },
    ],
  },
  {
    label: "数字资产",
    options: [{ value: "CRYPTO", label: "加密货币（Binance 现货）" }],
  },
];

export const CHART_MARKET_OPTIONS: ChartMarketOption[] = CHART_MARKET_GROUPS.flatMap((g) => g.options);

const MARKET_VALUE_SET = new Set(CHART_MARKET_OPTIONS.map((m) => m.value));

const EXCHANGE_ALIASES: Record<string, string> = {
  SSE: "SH",
  XSHG: "SH",
  SZSE: "SZ",
  XSHE: "SZ",
  BSE: "BJ",
  HKEX: "HK",
  HKG: "HK",
  NASDAQ: "US",
  NYSE: "US",
  AMEX: "US",
  OTC: "US",
  USA: "US",
  TSE: "JP",
  TYO: "JP",
  LSE: "UK",
  LON: "UK",
  XETRA: "DE",
  GER: "DE",
  EPA: "FR",
  PAR: "FR",
  TSX: "CA",
  TO: "CA",
  ASX: "AU",
  KRX: "KR",
  KOSPI: "KR",
  KOSDAQ: "KQ",
  TWSE: "TW",
  SGX: "SG",
  NSE: "IN",
  AMS: "NL",
  SIX: "CH",
  MIL: "IT",
  BME: "ES",
  CC: "CRYPTO",
  BINANCE: "CRYPTO",
  CRYPTO: "CRYPTO",
  CME: "CME",
  CBOT: "CME",
  NYMEX: "CME",
  COMEX: "CME",
  FUTURES: "CME",
  OPRA: "OPRA",
  OCC: "OPRA",
  OPTION: "OPRA",
};

export function coerceChartMarketExchange(raw: string): string {
  const u = raw.trim().toUpperCase();
  if (!u) return DEFAULT_CHART_SPEC.exchange;
  if (MARKET_VALUE_SET.has(u)) return u;
  if (EXCHANGE_ALIASES[u]) return EXCHANGE_ALIASES[u];
  return DEFAULT_CHART_SPEC.exchange;
}

/**
 * 从标的代码启发式推断交易所（左栏研究范围 → 画布联动用）。
 * 有明确 exchange 时仍应优先用 coerceChartMarketExchange。
 */
export function guessChartExchangeFromSymbol(symbol: string): string {
  const sym = symbol.trim().toUpperCase();
  if (!sym) return DEFAULT_CHART_SPEC.exchange;
  if (sym.includes(".")) {
    const suf = sym.split(".").pop() ?? "";
    return coerceChartMarketExchange(suf);
  }
  if (/^\d{6}$/.test(sym)) {
    if (sym.startsWith("6") || sym.startsWith("9")) return "SH";
    if (sym.startsWith("0") || sym.startsWith("3")) return "SZ";
    if (sym.startsWith("4") || sym.startsWith("8")) return "BJ";
  }
  if (/^\d{5}$/.test(sym)) return "HK";
  if (/^[A-Z0-9]+USDT?$/.test(sym) || sym.includes("BTC") || sym.includes("ETH")) return "CRYPTO";
  if (/^[A-Z0-9]{1,8}=F$/.test(sym) || /^\/[A-Z0-9]{1,4}$/.test(sym)) return "CME";
  if (/^[A-Z]{1,6}\d{6}[CP]\d{8}$/.test(sym)) return "OPRA";
  if (/^[A-Z]{1,5}$/.test(sym)) return "US";
  return DEFAULT_CHART_SPEC.exchange;
}

export const CHART_SPEC_STORAGE_KEY = "qubit-chart-spec-v1";

export function readPersistedChartSpec(): ChartSpec {
  try {
    const raw = localStorage.getItem(CHART_SPEC_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CHART_SPEC };
    const j = JSON.parse(raw) as Partial<ChartSpec>;
    const tf = typeof j.timeframe === "string" ? j.timeframe : DEFAULT_CHART_SPEC.timeframe;
    return {
      symbol: typeof j.symbol === "string" && j.symbol.trim() ? j.symbol.trim() : DEFAULT_CHART_SPEC.symbol,
      exchange: coerceChartMarketExchange(typeof j.exchange === "string" ? j.exchange : DEFAULT_CHART_SPEC.exchange),
      timeframe: (CHART_TIMEFRAMES as readonly string[]).includes(tf) ? tf : DEFAULT_CHART_SPEC.timeframe,
      limit:
        typeof j.limit === "number" && Number.isFinite(j.limit)
          ? Math.max(1, Math.min(2000, Math.floor(j.limit)))
          : DEFAULT_CHART_SPEC.limit,
    };
  } catch {
    return { ...DEFAULT_CHART_SPEC };
  }
}

export function persistChartSpec(spec: ChartSpec): void {
  try {
    localStorage.setItem(CHART_SPEC_STORAGE_KEY, JSON.stringify(spec));
  } catch {
    /* ignore quota */
  }
}

/** 工具栏 input/select 统一宽度 */
export const chartControlStyle: CSSProperties = {
  width: CHART_CONTROL_WIDTH_PX,
  minWidth: CHART_CONTROL_WIDTH_PX,
  maxWidth: CHART_CONTROL_WIDTH_PX,
  boxSizing: "border-box",
};
