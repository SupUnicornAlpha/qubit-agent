/**
 * Unified symbol arg extraction for ToolContract (docs/agent-contracts/01-tool-contract.md).
 * Reuses klines alias table so resolve/quote/klines share one truth.
 */

import { extractKlinesSymbols } from "./normalize-klines-request";

export type ToolArity = "one" | "many" | "either";

/** Alias of extractKlinesSymbols — preferred name in contract layer. */
export function extractSymbolArgs(raw: Record<string, unknown>): string[] {
  return extractKlinesSymbols(raw);
}

export class ToolContractParamError extends Error {
  readonly code: "missing_symbol" | "arity_violation";
  readonly receivedKeys: string;

  constructor(
    code: "missing_symbol" | "arity_violation",
    toolName: string,
    detail: string,
    receivedKeys: string
  ) {
    super(`${code}: ${toolName}: ${detail} (receivedKeys=${receivedKeys})`);
    this.name = "ToolContractParamError";
    this.code = code;
    this.receivedKeys = receivedKeys;
  }
}

export function receivedParamKeys(raw: Record<string, unknown>): string {
  const keys = Object.keys(raw).sort();
  return keys.length > 0 ? keys.join(",") : "(none)";
}

/**
 * Enforce arity and return deduped symbols.
 * - one: exactly one symbol required
 * - many: at least one (arrays preferred; scalar accepted)
 * - either: at least one; caller decides scalar vs batch response shape
 */
export function requireSymbols(
  raw: Record<string, unknown>,
  opts: { arity: ToolArity; toolName: string }
): string[] {
  const symbols = extractSymbolArgs(raw);
  const keys = receivedParamKeys(raw);
  if (symbols.length === 0) {
    throw new ToolContractParamError(
      "missing_symbol",
      opts.toolName,
      "symbol/ticker or symbols/tickers is required",
      keys
    );
  }
  if (opts.arity === "one" && symbols.length !== 1) {
    throw new ToolContractParamError(
      "arity_violation",
      opts.toolName,
      `expects exactly one symbol, got ${symbols.length}`,
      keys
    );
  }
  return symbols;
}
