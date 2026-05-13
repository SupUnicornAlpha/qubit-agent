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

export const CHART_MARKET_OPTIONS = [
  { value: "SH", label: "上交所 A" },
  { value: "SZ", label: "深交所 A" },
  { value: "BJ", label: "北交所" },
  { value: "HK", label: "港交所" },
  { value: "US", label: "美股" },
] as const;

export function coerceChartMarketExchange(raw: string): string {
  const u = raw.trim().toUpperCase();
  if (CHART_MARKET_OPTIONS.some((m) => m.value === u)) return u;
  if (u === "SSE" || u === "XSHG") return "SH";
  if (u === "SZSE" || u === "XSHE") return "SZ";
  if (u === "BSE") return "BJ";
  return CHART_MARKET_OPTIONS[0].value;
}
