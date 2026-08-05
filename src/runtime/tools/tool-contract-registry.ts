/**
 * Market-family ToolContract registry (P0).
 * Unregistered tools keep legacy ad-hoc param handling.
 */

import { extractSymbolArgs } from "../market/normalize-symbol-args";
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
      market_snapshot_empty: "retryable",
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
      const snapshotId = String(raw.snapshotId ?? raw.snapshot_id ?? "").trim();
      const symbols = extractSymbolArgs(raw);
      const scope = Array.isArray(raw.instrumentScope)
        ? (raw.instrumentScope as unknown[]).map(String)
        : Array.isArray(raw.instrument_scope)
          ? (raw.instrument_scope as unknown[]).map(String)
          : symbols;
      return {
        ...raw,
        ...(snapshotId ? { snapshotId } : {}),
        ...(scope.length > 0 ? { instrumentScope: scope, symbols: scope } : {}),
      };
    },
    requiredAfterNormalize: ["snapshotId"],
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
    normalize: normalizePassthrough,
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
