/**
 * Models often wrap real tool fields under `arguments` / `params` / `args`
 * (OpenAI-style nesting or copy-paste from call_mcp). Top-level keys win.
 */
export function unwrapToolArgs(raw: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> = { ...raw };
  for (const nestKey of ["arguments", "params", "args"] as const) {
    const nested = out[nestKey];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    out = { ...(nested as Record<string, unknown>), ...out };
    delete out[nestKey];
  }
  return out;
}

/** Default [end-daysAgo, end] as YYYY-MM-DD (UTC calendar). */
export function defaultDateWindow(daysAgo = 365): { start_date: string; end_date: string } {
  const end = new Date();
  const start = new Date(end.getTime() - daysAgo * 86_400_000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start_date: fmt(start), end_date: fmt(end) };
}

/** Coerce symbols[] or singular symbol/ticker/code. */
export function coerceSymbolList(params: Record<string, unknown>): string[] {
  const raw = params.symbols ?? params.tickers ?? params.universe_symbols;
  if (Array.isArray(raw)) {
    return raw
      .map((s) => String(s ?? "").trim())
      .filter(Boolean)
      .map((s) => s.replace(/^(US|HK|CN|SH|SZ):/i, ""));
  }
  const one = String(params.symbol ?? params.ticker ?? params.code ?? "").trim();
  if (!one) return [];
  if (one.includes(",")) {
    return one
      .split(",")
      .map((s) => s.trim().replace(/^(US|HK|CN|SH|SZ):/i, ""))
      .filter(Boolean);
  }
  return [one.replace(/^(US|HK|CN|SH|SZ):/i, "")];
}
