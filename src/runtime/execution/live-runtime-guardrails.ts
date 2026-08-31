/**
 * Runtime-scoped guardrails for real-money execution.
 *
 * This is intentionally separate from project risk rules: project policies are
 * shared controls, while a limited-live deployment needs a small, immutable
 * envelope attached to the exact strategy runtime that is being promoted.
 */
export type LiveRuntimeGuardrails = {
  schemaVersion: 1;
  allowedSymbols: string[];
  maxOrderNotionalUsd: number;
  maxDailyNotionalUsd: number;
  maxOrdersPerDay: number;
  maxDailyLossUsd: number;
  /** Every real-money intent remains behind the canonical review ticket. */
  requireHumanConfirmation: true;
};

export type LiveRuntimeGuardrailsParseResult =
  | { ok: true; guardrails: LiveRuntimeGuardrails }
  | { ok: false; error: string };

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizedSymbols(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return null;
  const symbols = value.map((item) => (typeof item === "string" ? item.trim().toUpperCase() : ""));
  if (symbols.some((symbol) => !symbol || symbol.length > 80)) return null;
  return [...new Set(symbols)];
}

/**
 * Strictly parse persisted JSON. An absent or malformed guardrail is never
 * interpreted as an unlimited live deployment.
 */
export function parseLiveRuntimeGuardrails(value: unknown): LiveRuntimeGuardrailsParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "live_runtime_guardrails_missing" };
  }
  const raw = value as Record<string, unknown>;
  const symbols = normalizedSymbols(raw.allowedSymbols);
  if (raw.schemaVersion !== 1) return { ok: false, error: "live_runtime_guardrails_schema_invalid" };
  if (!symbols) return { ok: false, error: "live_runtime_guardrails_allowed_symbols_invalid" };
  if (!positiveNumber(raw.maxOrderNotionalUsd)) {
    return { ok: false, error: "live_runtime_guardrails_max_order_notional_invalid" };
  }
  if (!positiveNumber(raw.maxDailyNotionalUsd)) {
    return { ok: false, error: "live_runtime_guardrails_max_daily_notional_invalid" };
  }
  if (raw.maxDailyNotionalUsd < raw.maxOrderNotionalUsd) {
    return { ok: false, error: "live_runtime_guardrails_daily_notional_below_order_notional" };
  }
  if (!positiveInteger(raw.maxOrdersPerDay)) {
    return { ok: false, error: "live_runtime_guardrails_max_orders_invalid" };
  }
  if (!positiveNumber(raw.maxDailyLossUsd)) {
    return { ok: false, error: "live_runtime_guardrails_max_daily_loss_invalid" };
  }
  if (raw.requireHumanConfirmation !== true) {
    return { ok: false, error: "live_runtime_guardrails_human_confirmation_required" };
  }
  return {
    ok: true,
    guardrails: {
      schemaVersion: 1,
      allowedSymbols: symbols,
      maxOrderNotionalUsd: raw.maxOrderNotionalUsd,
      maxDailyNotionalUsd: raw.maxDailyNotionalUsd,
      maxOrdersPerDay: raw.maxOrdersPerDay,
      maxDailyLossUsd: raw.maxDailyLossUsd,
      requireHumanConfirmation: true,
    },
  };
}

export function assertLiveRuntimeGuardrailsForSymbol(
  value: unknown,
  symbol: string
): LiveRuntimeGuardrails {
  const parsed = parseLiveRuntimeGuardrails(value);
  if (!parsed.ok) throw new Error(parsed.error);
  if (!parsed.guardrails.allowedSymbols.includes(symbol.trim().toUpperCase())) {
    throw new Error("live_runtime_symbol_not_allowlisted");
  }
  return parsed.guardrails;
}
