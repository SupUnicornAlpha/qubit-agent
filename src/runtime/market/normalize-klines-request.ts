import { resolveTickerMarket } from "./resolve-ticker-market";

export interface NormalizedKlinesToolRequest {
  symbol: string;
  exchange: string;
  timeframe: string;
  limit: number;
  startDate?: string;
  endDate?: string;
}

export function extractKlinesSymbols(raw: Record<string, unknown>): string[] {
  const scalar = firstString(raw, [
    "symbol",
    "ticker",
    "code",
    "securityCode",
    "instrument",
    "instrumentId",
  ]);
  if (scalar) return [scalar];
  for (const key of ["symbols", "tickers", "codes", "instruments"]) {
    const value = raw[key];
    if (Array.isArray(value)) {
      return [
        ...new Set(
          value
            .filter(
              (item): item is string | number =>
                typeof item === "string" || typeof item === "number"
            )
            .map(String)
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ];
    }
  }
  return [];
}

const TIMEFRAME_ALIASES: Record<string, string> = {
  d: "1d",
  day: "1d",
  daily: "1d",
  "1day": "1d",
  w: "1w",
  week: "1w",
  weekly: "1w",
  "1week": "1w",
  "60m": "1h",
  h: "1h",
  hour: "1h",
  hourly: "1h",
  "240m": "4h",
};

function firstString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizeSymbolAndExchange(
  rawSymbol: string,
  rawExchange: string,
  rawMarket: string
): { symbol: string; exchange: string } {
  let symbol = rawSymbol.trim().toUpperCase();
  let exchange = rawExchange.trim().toUpperCase();

  // Common vendor formats: SH600000 / SZ300750 / BJ830839.
  const prefixedCn = symbol.match(/^(SH|SZ|BJ)(\d{6})$/);
  if (prefixedCn) {
    exchange ||= prefixedCn[1] ?? "";
    symbol = prefixedCn[2] ?? symbol;
  }

  const resolved = resolveTickerMarket(symbol, {
    // A generic market=CN must not override 300xxx/000xxx to Shanghai.
    ...(exchange ? { hintExchange: exchange } : {}),
  });
  if (!exchange && resolved.exchange !== "UNKNOWN") exchange = resolved.exchange;

  // Provider-neutral form. Each source adapter adds its own suffix.
  const dot = symbol.lastIndexOf(".");
  if (dot > 0 && resolved.confidence === "explicit") {
    symbol = symbol.slice(0, dot);
  }

  if (!exchange && rawMarket) {
    const market = rawMarket.trim().toUpperCase();
    if (market !== "CN" && market !== "A-SHARE" && market !== "ASHARE") exchange = market;
  }

  return { symbol, exchange };
}

/**
 * Normalize the loose parameter vocabulary emitted by different agents/MCPs to
 * the single contract understood by qubit-data.
 */
export function normalizeKlinesToolRequest(
  raw: Record<string, unknown>,
  defaults: { timeframe?: string; limit?: number } = {}
): NormalizedKlinesToolRequest {
  const rawSymbol = extractKlinesSymbols(raw)[0] ?? "";
  const rawExchange = firstString(raw, ["exchange", "venue", "exchangeCode"]);
  const rawMarket = firstString(raw, ["market", "region"]);
  const { symbol, exchange } = normalizeSymbolAndExchange(rawSymbol, rawExchange, rawMarket);

  const rawTimeframe = firstString(raw, [
    "timeframe",
    "period",
    "interval",
    "frequency",
    "barSize",
  ]).toLowerCase();
  const timeframe = TIMEFRAME_ALIASES[rawTimeframe] ?? rawTimeframe ?? defaults.timeframe ?? "1d";

  const rawLimit = firstString(raw, ["limit", "count", "bars", "size", "lookback", "lookbackDays"]);
  const parsedLimit = Number(rawLimit || defaults.limit || 120);
  const limit = Math.max(1, Math.min(Number.isFinite(parsedLimit) ? parsedLimit : 120, 2000));
  const rawStart = firstString(raw, ["startDate", "start_date", "startTime", "start_time", "from"]);
  const rawEnd = firstString(raw, ["endDate", "end_date", "endTime", "end_time", "to"]);
  const startMs = Date.parse(rawStart);
  const endMs = Date.parse(rawEnd);
  const explicitRange =
    Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? {
          startDate: new Date(startMs).toISOString(),
          endDate: new Date(endMs).toISOString(),
        }
      : {};

  return {
    symbol,
    exchange,
    timeframe: timeframe || defaults.timeframe || "1d",
    limit,
    ...explicitRange,
  };
}
