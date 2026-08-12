/**
 * Strip bulky time-series from tool / backtest payloads before shipping to Team UI.
 * Full curves stay in DB / getBacktestJob; graph + list endpoints only need metrics.
 */

const HEAVY_ARRAY_KEYS = new Set([
  "equityCurve",
  "equity_curve",
  "trades",
  "bars",
  "klines",
  "candles",
  "prices",
  "history",
  "timeseries",
  "timeSeries",
  "points",
  "samples",
]);

const MAX_DEPTH = 8;
const MAX_STRING = 4_000;
const MAX_ARRAY_PREVIEW = 8;

export function compactHeavyJson(value: unknown, depth = 0): unknown {
  if (value == null || depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…(+${value.length - MAX_STRING} chars)`
      : value;
  }
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    if (value.length <= MAX_ARRAY_PREVIEW) {
      return value.map((item) => compactHeavyJson(item, depth + 1));
    }
    return {
      __compact: true,
      length: value.length,
      preview: value.slice(0, MAX_ARRAY_PREVIEW).map((item) => compactHeavyJson(item, depth + 1)),
    };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(v) && HEAVY_ARRAY_KEYS.has(k)) {
      out[k] = { __compact: true, length: v.length };
      continue;
    }
    // Nested backtest observation / result blobs
    if (
      (k === "result" || k === "observation" || k === "performance" || k === "data") &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = compactHeavyJson(v, depth + 1);
      continue;
    }
    out[k] = compactHeavyJson(v, depth + 1);
  }
  return out;
}

/** List-view backtest result: keep metrics, drop equity/trades series. */
export function compactBacktestResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  const equity = r.equityCurve ?? r.equity_curve;
  const trades = r.trades;
  return {
    ...r,
    ...(Array.isArray(equity) ? { equityCurve: { __compact: true, length: equity.length } } : {}),
    ...(Array.isArray(trades) ? { trades: { __compact: true, length: trades.length } } : {}),
    metrics: r.metrics ?? null,
    meta: r.meta ?? null,
  };
}
