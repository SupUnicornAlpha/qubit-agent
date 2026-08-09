/**
 * Market-family ToolContract registry (P0).
 * Unregistered tools keep legacy ad-hoc param handling.
 */

import { extractSymbolArgs } from "../market/normalize-symbol-args";
import {
  coerceConfidence01,
  extractForecastBookKey,
  extractSnapshotId,
  resolveInstrumentScope,
  resolveThesisDirection,
} from "./research-arg-normalize";
import {
  type ToolContract,
  normalizeMarketSymbolParams,
  normalizePassthrough,
} from "./tool-contract";

const MARKET_SYMBOL_ERRORS = {
  missing_symbol: "permanent",
  arity_violation: "permanent",
  market_data_unavailable: "permanent",
} as const;

function marketSymbolContract(
  name: string,
  kind: ToolContract["kind"],
  arity: ToolContract["arity"] = "either"
): ToolContract {
  return {
    name,
    kind,
    category: "market",
    arity,
    requiredAfterNormalize: ["symbols"],
    normalize: (raw) => normalizeMarketSymbolParams(raw, { arity, toolName: name }),
    errorCodes: { ...MARKET_SYMBOL_ERRORS },
    timeoutClass: name === "market.resolve_symbol" ? "light" : "market",
    sideEffects: "none",
    lifecycle: "active",
  };
}

const MARKET_CONTRACTS: ToolContract[] = [
  marketSymbolContract("market.resolve_symbol", "builtin", "either"),
  marketSymbolContract("fetch_quote", "connector", "either"),
  marketSymbolContract("fetch_klines", "connector", "either"),
  marketSymbolContract("fetch_ticks", "connector", "either"),
  {
    name: "fetch_news",
    kind: "connector",
    category: "sentiment",
    arity: "either",
    normalize: (raw) => {
      const symbols = extractSymbolArgs(raw);
      return symbols.length > 0 ? { ...raw, symbols } : { ...raw };
    },
    errorCodes: {
      news_source_unconfigured: "permanent",
      news_items_empty: "permanent",
      missing_symbol: "permanent",
    },
    timeoutClass: "market",
    sideEffects: "none",
    lifecycle: "active",
  },
  {
    name: "fetch_fundamentals",
    kind: "connector",
    category: "market",
    arity: "one",
    requiredAfterNormalize: ["symbols"],
    normalize: (raw) => ({
      ...normalizeMarketSymbolParams(raw, { arity: "one", toolName: "fetch_fundamentals" }),
      reportType: raw.reportType === "annual" ? "annual" : "quarterly",
      periods: Math.max(1, Math.min(Number(raw.periods ?? 4), 12)),
    }),
    errorCodes: {
      ...MARKET_SYMBOL_ERRORS,
      fundamentals_source_unavailable: "permanent",
      fundamentals_data_unavailable: "permanent",
    },
    timeoutClass: "market",
    sideEffects: "none",
    lifecycle: "active",
  },
  {
    name: "factor.compute",
    kind: "builtin",
    category: "research",
    arity: "either",
    requiredAfterNormalize: ["factor_id", "symbols"],
    normalize: (raw) => ({
      ...normalizeMarketSymbolParams(raw, { arity: "either", toolName: "factor.compute" }),
      factor_id:
        raw.factor_id ??
        raw.factorId ??
        (Array.isArray(raw.factor_ids) ? raw.factor_ids[0] : undefined),
    }),
    errorCodes: { factor_not_found: "permanent", no_factor_values_written: "permanent" },
    timeoutClass: "market",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "factor.promote_backtest",
    kind: "builtin",
    category: "backtest",
    arity: "either",
    requiredAfterNormalize: ["factor_ids", "start_date", "end_date"],
    normalize: (raw) => ({
      ...raw,
      factor_ids: raw.factor_ids ?? raw.factorIds ?? (raw.factor_id ? [raw.factor_id] : undefined),
      start_date: raw.start_date ?? raw.startDate ?? raw.from,
      end_date: raw.end_date ?? raw.endDate ?? raw.to ?? raw.asOf,
    }),
    errorCodes: { factor_not_found: "permanent", missing_factor_ids: "permanent" },
    timeoutClass: "market",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "backtest.run",
    kind: "builtin",
    category: "backtest",
    arity: "either",
    requiredAfterNormalize: ["strategy_version_id", "symbols"],
    normalize: (raw) => ({
      ...normalizeMarketSymbolParams(raw, { arity: "either", toolName: "backtest.run" }),
      strategy_version_id: raw.strategy_version_id ?? raw.strategyVersionId,
    }),
    errorCodes: { factor_not_found: "permanent", missing_strategy_version_id: "permanent" },
    timeoutClass: "market",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "strategy.compose",
    kind: "builtin",
    category: "research",
    arity: "either",
    requiredAfterNormalize: ["strategy_version_id"],
    normalize: (raw) => ({
      ...raw,
      strategy_version_id: raw.strategy_version_id ?? raw.strategyVersionId,
    }),
    errorCodes: { missing_strategy_version_id: "permanent" },
    timeoutClass: "light",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "strategy.compile",
    kind: "builtin",
    category: "research",
    arity: "either",
    requiredAfterNormalize: ["code"],
    normalize: (raw) => ({ ...raw, code: raw.code ?? raw.strategyCode ?? raw.source }),
    errorCodes: { missing_code: "permanent" },
    timeoutClass: "light",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "factor.mine.llm",
    kind: "builtin",
    category: "research",
    arity: "many",
    requiredAfterNormalize: ["expressions", "symbols", "start_date", "end_date"],
    normalize: (raw) => ({
      ...normalizeMarketSymbolParams(raw, { arity: "many", toolName: "factor.mine.llm" }),
      expressions: raw.expressions ?? raw.factorExpressions ?? raw.factor_expressions,
      start_date: raw.start_date ?? raw.startDate ?? raw.from,
      end_date: raw.end_date ?? raw.endDate ?? raw.to,
      min_count: Math.max(1, Number(raw.min_count ?? raw.minCount ?? 5)),
    }),
    validate: (canonical) => {
      const expressions = Array.isArray(canonical.expressions)
        ? canonical.expressions.filter((item) => typeof item === "string" && item.trim())
        : [];
      const minCount = Number(canonical.min_count ?? 5);
      if (expressions.length < minCount) {
        throw new Error(
          `factor_expression_batch_too_small: factor.mine.llm requires at least ${minCount} expressions`
        );
      }
    },
    errorCodes: {
      ...MARKET_SYMBOL_ERRORS,
      factor_expression_batch_too_small: "permanent",
      missing_expressions: "permanent",
      missing_start_date: "permanent",
      missing_end_date: "permanent",
    },
    timeoutClass: "market",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "order.create_intent",
    kind: "builtin",
    category: "trading",
    arity: "one",
    requiredAfterNormalize: ["symbols", "side", "qty"],
    normalize: (raw) => ({
      ...normalizeMarketSymbolParams(raw, { arity: "one", toolName: "order.create_intent" }),
      strategy_version_id: raw.strategy_version_id ?? raw.strategyVersionId,
      side: raw.side ?? raw.direction ?? raw.action,
      qty: raw.qty ?? raw.quantity ?? raw.shares,
      order_type: raw.order_type ?? raw.orderType ?? "market",
      dispatch_mode: raw.dispatch_mode ?? raw.dispatchMode ?? "paper",
    }),
    validate: (canonical) => {
      const qty = Number(canonical.qty);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error("invalid_qty: order.create_intent qty must be a positive number");
      }
    },
    errorCodes: {
      ...MARKET_SYMBOL_ERRORS,
      missing_side: "permanent",
      missing_qty: "permanent",
      invalid_qty: "permanent",
      missing_strategy_version_id: "permanent",
      invalid_order_type: "permanent",
    },
    timeoutClass: "light",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "market.readiness",
    kind: "builtin",
    category: "market",
    arity: "either",
    normalize: normalizePassthrough,
    errorCodes: {},
    timeoutClass: "light",
    sideEffects: "none",
    lifecycle: "active",
  },
  {
    name: "market.snapshot.get",
    kind: "builtin",
    category: "market",
    arity: "either",
    normalize: (raw) => {
      const snapshotId = typeof raw.snapshotId === "string" ? raw.snapshotId.trim() : "";
      if (snapshotId) return { ...raw, snapshotId };
      return normalizeMarketSymbolParams(raw, {
        arity: "either",
        toolName: "market.snapshot.get",
      });
    },
    requiredAfterNormalize: [],
    errorCodes: {
      ...MARKET_SYMBOL_ERRORS,
      snapshot_not_found: "permanent",
      market_snapshot_empty: "transient",
      invalid_asOf: "permanent",
    },
    timeoutClass: "market",
    sideEffects: "none",
    lifecycle: "active",
  },
  {
    name: "research.thesis.write",
    kind: "builtin",
    category: "research",
    arity: "either",
    normalize: (raw) => {
      const snapshotId =
        String(raw.snapshotId ?? raw.snapshot_id ?? "").trim() || extractSnapshotId(raw);
      const scope = resolveInstrumentScope(raw);
      const direction = resolveThesisDirection(raw);
      const confidence = coerceConfidence01(raw.confidence, 0.5);
      return {
        ...raw,
        ...(snapshotId ? { snapshotId } : {}),
        ...(scope.length > 0 ? { instrumentScope: scope, symbols: scope } : {}),
        direction,
        confidence,
      };
    },
    // snapshotId may be auto-filled / unbound in the handler when symbols exist
    requiredAfterNormalize: [],
    errorCodes: {
      missing_snapshotId: "permanent",
      missing_instrumentScope: "permanent",
      invalid_confidence: "permanent",
    },
    timeoutClass: "light",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "research.forecast_book.get",
    kind: "builtin",
    category: "research",
    arity: "either",
    normalize: (raw) => {
      const { thesisId, entryId } = extractForecastBookKey(raw);
      return {
        ...raw,
        ...(thesisId ? { thesisId } : {}),
        ...(entryId ? { entryId } : {}),
      };
    },
    errorCodes: {
      forecast_book_not_found: "permanent",
    },
    timeoutClass: "light",
    sideEffects: "none",
    lifecycle: "active",
  },
  {
    name: "research.forecast_book.link",
    kind: "builtin",
    category: "research",
    arity: "either",
    normalize: normalizePassthrough,
    errorCodes: {
      forecast_book_missing_snapshot: "permanent",
    },
    timeoutClass: "light",
    sideEffects: "write",
    lifecycle: "active",
  },
  {
    name: "portfolio.construct",
    kind: "builtin",
    category: "trading",
    arity: "either",
    normalize: normalizePassthrough,
    errorCodes: {
      thesis_not_found: "permanent",
      snapshot_thesis_mismatch: "permanent",
    },
    timeoutClass: "market",
    sideEffects: "none",
    lifecycle: "active",
  },
];

const BY_NAME = new Map(MARKET_CONTRACTS.map((c) => [c.name, c]));

export function getToolContract(toolName: string): ToolContract | undefined {
  return BY_NAME.get(toolName);
}

export function listRegisteredToolContracts(): ToolContract[] {
  return [...MARKET_CONTRACTS];
}
