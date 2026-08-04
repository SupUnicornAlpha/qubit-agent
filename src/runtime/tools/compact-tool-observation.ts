/**
 * Shrink bulky tool results before they enter ReAct observations (TTFT).
 * Full payloads remain in the workflow artifact ledger / interaction log.
 */
export function compactMarketBarsPayload(
  bars: unknown,
  opts: { keepTail?: number } = {}
): Record<string, unknown> {
  const keepTail = opts.keepTail ?? 40;
  if (!Array.isArray(bars)) {
    return { bars };
  }
  if (bars.length === 0) {
    return { barCount: 0, bars: [], note: "empty_bars" };
  }

  const first = bars[0] as Record<string, unknown> | null;
  const last = bars[bars.length - 1] as Record<string, unknown> | null;
  const closes = bars
    .map((bar) => {
      if (!bar || typeof bar !== "object") return null;
      const close = (bar as Record<string, unknown>).close;
      return typeof close === "number" && Number.isFinite(close) ? close : null;
    })
    .filter((v): v is number => v !== null);

  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const bar of bars) {
    if (!bar || typeof bar !== "object") continue;
    const row = bar as Record<string, unknown>;
    const h = typeof row.high === "number" ? row.high : null;
    const l = typeof row.low === "number" ? row.low : null;
    if (h !== null && h > high) high = h;
    if (l !== null && l < low) low = l;
  }

  const tail = bars.length > keepTail ? bars.slice(-keepTail) : bars;
  return {
    barCount: bars.length,
    compacted: bars.length > keepTail,
    keepTail: tail.length,
    range: {
      firstTs: first && typeof first === "object" ? first.timestamp ?? first.ts ?? null : null,
      lastTs: last && typeof last === "object" ? last.timestamp ?? last.ts ?? null : null,
      firstClose: closes[0] ?? null,
      lastClose: closes[closes.length - 1] ?? null,
      high: Number.isFinite(high) ? high : null,
      low: Number.isFinite(low) ? low : null,
    },
    bars: tail,
    note:
      bars.length > keepTail
        ? `full series compacted for prompt; kept last ${keepTail} bars + range stats`
        : "full series kept",
  };
}

export function compactToolObservationValue(
  toolName: string,
  value: unknown
): unknown {
  const name = toolName.toLowerCase();
  const isKlines =
    name.includes("fetch_klines") ||
    name.includes("fetch_price_data") ||
    name.endsWith("/fetch_klines") ||
    name.endsWith("/fetch_price_data");

  if (!isKlines) return value;

  if (Array.isArray(value)) {
    return compactMarketBarsPayload(value);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj.bars)) {
      const compact = compactMarketBarsPayload(obj.bars);
      return {
        ...obj,
        ...compact,
        // Prefer compact bars; drop accidental duplicate full arrays
        bars: compact.bars,
      };
    }
    if (Array.isArray(obj.connectorResult)) {
      return {
        ...obj,
        connectorResult: compactMarketBarsPayload(obj.connectorResult),
      };
    }
  }
  return value;
}
