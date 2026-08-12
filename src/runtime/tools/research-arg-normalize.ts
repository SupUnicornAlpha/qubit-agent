/**
 * Shared arg coercion for research / portfolio / recommendation tools.
 * Models frequently pass aliases, nested bags, labels, or free-text directions.
 */

const CONFIDENCE_LABELS: Record<string, number> = {
  very_low: 0.15,
  low: 0.3,
  medium: 0.5,
  med: 0.5,
  mid: 0.5,
  high: 0.75,
  very_high: 0.9,
  低: 0.3,
  中: 0.5,
  高: 0.75,
};

/** Coerce confidence to [0,1]: labels, percentages (≤100), or already-normalized. */
export function coerceConfidence01(raw: unknown, fallback = 0.5): number {
  if (typeof raw === "string") {
    const key = raw.trim().toLowerCase().replace(/\s+/g, "_");
    if (key in CONFIDENCE_LABELS) return CONFIDENCE_LABELS[key]!;
    const n = Number(raw.trim());
    if (Number.isFinite(n)) return coerceConfidence01(n, fallback);
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n > 1 && n <= 100) return Math.max(0, Math.min(1, n / 100));
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

const LONG_HINT = /^(long|buy|bull|看多|做多|多头|偏多|看涨|反弹|低吸)/i;
const SHORT_HINT = /^(short|sell|bear|看空|做空|空头|偏空|看跌|减仓|高抛)/i;
const NEUTRAL_HINT = /^(neutral|hold|flat|swing|t_swing|t-swing|中性|观望|震荡|横盘|波段|做t)/i;

export function coerceThesisDirection(raw: unknown): "long" | "short" | "neutral" | null {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower === "long" || lower === "short" || lower === "neutral") return lower;
  if (LONG_HINT.test(text)) return "long";
  if (SHORT_HINT.test(text)) return "short";
  if (NEUTRAL_HINT.test(text)) return "neutral";
  // Free-text Chinese like "震荡反弹/日内高抛低吸" → neutral (range-bound)
  if (/震荡|高抛低吸|做\s*t|波段/.test(text)) return "neutral";
  if (/多|涨|反弹|低吸/.test(text) && !/空|跌/.test(text)) return "long";
  if (/空|跌|减仓/.test(text) && !/多|涨/.test(text)) return "short";
  return null;
}

/** Infer recommendation side from side/action/conviction free text. */
export function coerceRecommendationSide(raw: unknown): "long" | "short" | "neutral" | null {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase();
  if (!text) return null;
  const map: Record<string, "long" | "short" | "neutral"> = {
    buy: "long",
    long: "long",
    bullish: "long",
    sell: "short",
    short: "short",
    bearish: "short",
    hold: "neutral",
    neutral: "neutral",
  };
  if (map[text]) return map[text]!;
  return coerceThesisDirection(raw);
}

/** Pull ticker-like tokens from free text (narrative / body). */
export function inferSymbolsFromText(text: string, max = 8): string[] {
  if (!text?.trim()) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  // A-share: 6 digits optional .SH/.SZ/.SS
  const cn = text.matchAll(/\b([0-9]{6})(?:\.(?:SH|SZ|SS))?\b/gi);
  for (const m of cn) {
    const raw = m[0]?.toUpperCase().replace(/\.SS$/, ".SH");
    const key = raw.includes(".") ? raw : raw;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(raw.includes(".") ? raw : key);
    if (found.length >= max) return found;
  }
  // US / HK tickers: 1–5 letters, optional market prefix
  const us = text.matchAll(/\b(?:US:|HK:)?([A-Z]{1,5})\b/g);
  const stop = new Set([
    "THE",
    "AND",
    "FOR",
    "WITH",
    "FROM",
    "THIS",
    "THAT",
    "RSI",
    "MACD",
    "SMA",
    "EMA",
    "PE",
    "PB",
    "CEO",
    "IPO",
    "ETF",
    "USD",
    "CNY",
    "HTTP",
    "HTTPS",
    "JSON",
    "NULL",
  ]);
  for (const m of us) {
    const sym = (m[1] ?? "").toUpperCase();
    if (!sym || stop.has(sym) || sym.length < 2) continue;
    if (seen.has(sym)) continue;
    seen.add(sym);
    found.push(sym);
    if (found.length >= max) break;
  }
  return found;
}

/** Prefer explicit direction; else infer from narrative/body; else neutral. */
export function resolveThesisDirection(
  params: Record<string, unknown>
): "long" | "short" | "neutral" {
  const direct = coerceThesisDirection(params.direction);
  if (direct) return direct;
  const prose = String(params.narrative ?? params.body ?? params.summary ?? params.text ?? "");
  const fromProse = coerceThesisDirection(prose.slice(0, 200));
  if (fromProse) return fromProse;
  return "neutral";
}

/** Resolve instrumentScope: explicit array, aliases, or tickers inferred from prose. */
export function resolveInstrumentScope(params: Record<string, unknown>): string[] {
  const raw =
    params.instrumentScope ??
    params.instrument_scope ??
    params.symbols ??
    params.tickers ??
    params.symbol;
  if (typeof raw === "string" && raw.trim()) {
    const one = raw.trim().toUpperCase();
    return one.includes(",")
      ? one
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [one];
  }
  if (Array.isArray(raw)) {
    const out = raw
      .map((x) =>
        String(x ?? "")
          .trim()
          .toUpperCase()
      )
      .filter(Boolean);
    if (out.length) return out;
  }
  const prose = String(params.narrative ?? params.body ?? params.summary ?? params.text ?? "");
  return inferSymbolsFromText(prose);
}

/** Pull snapshotId from explicit fields or evidence[].ref / evidence string. */
export function extractSnapshotId(params: Record<string, unknown>): string {
  const direct = String(params.snapshotId ?? params.snapshot_id ?? "").trim();
  if (direct) return direct;

  const evidence = params.evidence;
  if (Array.isArray(evidence)) {
    for (const item of evidence) {
      if (typeof item === "string") {
        const m = item.match(/mkt_snapshot_[a-z0-9]+/i);
        if (m) return m[0]!;
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      for (const key of ["ref", "snapshotId", "snapshot_id", "id", "source"]) {
        const v = String(row[key] ?? "").trim();
        if (v.startsWith("mkt_snapshot_")) return v;
      }
      const note = String(row.note ?? "");
      const m = note.match(/mkt_snapshot_[a-z0-9]+/i);
      if (m) return m[0]!;
    }
  }
  if (typeof evidence === "string") {
    const m = evidence.match(/mkt_snapshot_[a-z0-9]+/i);
    if (m) return m[0]!;
  }
  return "";
}

/** Map bookId / forecastBookId aliases onto entryId for forecast_book.get. */
export function extractForecastBookKey(params: Record<string, unknown>): {
  thesisId: string;
  entryId: string;
} {
  const thesisId = String(params.thesisId ?? params.thesis_id ?? "").trim();
  const entryId = String(
    params.entryId ??
      params.entry_id ??
      params.bookId ??
      params.book_id ??
      params.forecastBookId ??
      params.forecast_book_id ??
      ""
  ).trim();
  return { thesisId, entryId };
}

type LooseCandidate = {
  symbol: string;
  side: "long" | "short";
  price: number;
  confidence: number;
  stopLoss: number | null;
  currentQty: number;
  sector: string | null;
  proposedWeight: number | null;
};

/** Accept candidates[] or allocation[] (weight-only rows from models). */
export function normalizePortfolioCandidates(
  params: Record<string, unknown>
): LooseCandidate[] | undefined {
  const rawList = Array.isArray(params.candidates)
    ? params.candidates
    : Array.isArray(params.allocation)
      ? params.allocation
      : null;
  if (!rawList) return undefined;

  const out: LooseCandidate[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const symbol = String(row.symbol ?? row.ticker ?? "")
      .trim()
      .toUpperCase();
    if (!symbol) continue;
    const sideRaw = coerceRecommendationSide(row.side ?? row.direction) ?? "long";
    const side = sideRaw === "short" ? "short" : "long";
    const price = Number(row.price ?? row.last ?? row.close ?? 0);
    const weight = Number(row.weight ?? row.proposedWeight ?? row.proposed_weight);
    out.push({
      symbol,
      side,
      price: Number.isFinite(price) && price > 0 ? price : 0,
      confidence: coerceConfidence01(row.confidence, 0.5),
      stopLoss:
        row.stopLoss != null && Number.isFinite(Number(row.stopLoss)) ? Number(row.stopLoss) : null,
      currentQty: Number(row.currentQty ?? 0) || 0,
      sector: typeof row.sector === "string" ? row.sector : null,
      proposedWeight: Number.isFinite(weight) && weight > 0 ? weight : null,
    });
  }
  return out;
}
