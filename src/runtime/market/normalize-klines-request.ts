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
    // 模型常误写 symbols:"AAPL" / symbols:"AAPL,MSFT"（字符串而非数组）
    if (typeof value === "string" && value.trim()) {
      return [
        ...new Set(
          value
            .split(/[,;\s]+/)
            .map((item) => item.trim())
            .filter(Boolean)
        ),
      ];
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return [String(value)];
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

/** Calendar-day window used when only one side of the range is provided. */
function windowMsForLimit(timeframe: string, limit: number): number {
  const n = Math.max(1, Math.min(limit, 2000));
  const tf = (timeframe || "1d").toLowerCase();
  const unit =
    tf === "1w" || tf === "week" || tf === "weekly"
      ? 7 * 24 * 60 * 60 * 1000
      : tf === "1h" || tf === "60m" || tf === "hour"
        ? 60 * 60 * 1000
        : tf === "4h" || tf === "240m"
          ? 4 * 60 * 60 * 1000
          : tf.endsWith("m")
            ? Math.max(1, Number.parseInt(tf, 10) || 1) * 60 * 1000
            : 24 * 60 * 60 * 1000;
  return unit * (n - 1);
}

/**
 * Normalize the loose parameter vocabulary emitted by different agents/MCPs to
 * the single contract understood by qubit-data.
 *
 * Default limit aligns with Market Data prompt (≈250 trading days ≈ 1Y).
 * One-sided dates are filled: end-only → start = end - limit window;
 * start-only → end = asOf/now (or start + limit when start is in the past beyond window).
 */
export function normalizeKlinesToolRequest(
  raw: Record<string, unknown>,
  defaults: { timeframe?: string; limit?: number; asOfMs?: number } = {}
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

  const defaultLimit = defaults.limit ?? 250;
  const rawLimit = firstString(raw, ["limit", "count", "bars", "size", "lookback", "lookbackDays"]);
  const parsedLimit = Number(rawLimit || defaultLimit);
  const limit = Math.max(
    1,
    Math.min(Number.isFinite(parsedLimit) ? parsedLimit : defaultLimit, 2000)
  );
  const rawStart = firstString(raw, ["startDate", "start_date", "startTime", "start_time", "from"]);
  const rawEnd = firstString(raw, [
    "endDate",
    "end_date",
    "endTime",
    "end_time",
    "to",
    "asOf",
    "as_of",
  ]);
  const startMs = Date.parse(rawStart);
  const endMs = Date.parse(rawEnd);
  const asOfMs =
    typeof defaults.asOfMs === "number" && Number.isFinite(defaults.asOfMs)
      ? defaults.asOfMs
      : Date.now();
  const win = windowMsForLimit(timeframe || defaults.timeframe || "1d", limit);

  let range: { startDate?: string; endDate?: string } = {};
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
    range = {
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(endMs).toISOString(),
    };
  } else if (Number.isFinite(endMs) && !Number.isFinite(startMs)) {
    range = {
      startDate: new Date(endMs - win).toISOString(),
      endDate: new Date(endMs).toISOString(),
    };
  } else if (Number.isFinite(startMs) && !Number.isFinite(endMs)) {
    const end = Math.max(startMs + win, asOfMs);
    range = {
      startDate: new Date(startMs).toISOString(),
      endDate: new Date(end).toISOString(),
    };
  }

  return {
    symbol,
    exchange,
    timeframe: timeframe || defaults.timeframe || "1d",
    limit,
    ...range,
  };
}
