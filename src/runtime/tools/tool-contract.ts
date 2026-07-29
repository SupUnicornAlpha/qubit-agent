/**
 * ToolContract — param/result/error contract for registered tools.
 * See docs/agent-contracts/01-tool-contract.md
 */

import {
  type ToolArity,
  extractSymbolArgs,
  requireSymbols,
} from "../market/normalize-symbol-args";

export type { ToolArity };
export type ToolTimeoutClass = "light" | "market" | "team" | "mcp";
export type ToolContractErrorClass = "transient" | "permanent" | "blocked";
export type ToolContractKind = "builtin" | "connector" | "mcp" | "team";

export type CanonicalToolParams = Record<string, unknown> & {
  /** Market-family canonical symbols (length >= 1 after validate). */
  symbols?: string[];
};

export type ToolContract = {
  name: string;
  kind: ToolContractKind;
  category: string;
  arity: ToolArity;
  /** Soft schema: required business keys after normalize (harness fields excluded). */
  requiredAfterNormalize?: string[];
  normalize: (raw: Record<string, unknown>) => CanonicalToolParams;
  validate?: (canonical: CanonicalToolParams) => void;
  errorCodes: Record<string, ToolContractErrorClass>;
  timeoutClass: ToolTimeoutClass;
  sideEffects: "none" | "plan" | "a2a" | "write";
  lifecycle?: "active" | "deprecated" | "stub";
};

export function isToolContractEnabled(): boolean {
  return process.env["TOOL_CONTRACT_ENABLED"] !== "0";
}

export function timeoutMsForClass(timeoutClass: ToolTimeoutClass, fallbackMs: number): number {
  switch (timeoutClass) {
    case "light":
      return 15_000;
    case "market":
      return 60_000;
    case "mcp":
      return 60_000;
    case "team":
      return fallbackMs;
    default:
      return fallbackMs;
  }
}

/** Market tools that require at least one symbol. */
export function normalizeMarketSymbolParams(
  raw: Record<string, unknown>,
  opts: { arity: ToolArity; toolName: string }
): CanonicalToolParams {
  const symbols = requireSymbols(raw, opts);
  return {
    ...raw,
    symbols,
    // Keep scalar mirrors for handlers that still read symbol/ticker.
    symbol: symbols[0],
    ticker: symbols[0],
  };
}

export function normalizePassthrough(raw: Record<string, unknown>): CanonicalToolParams {
  return { ...raw };
}

export function applyToolContract(
  contract: ToolContract,
  raw: Record<string, unknown>
): CanonicalToolParams {
  const canonical = contract.normalize(raw);
  if (contract.validate) contract.validate(canonical);
  if (contract.requiredAfterNormalize) {
    for (const key of contract.requiredAfterNormalize) {
      const value = canonical[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(
          `missing_symbol: ${contract.name}: required field "${key}" missing after normalize`
        );
      }
      if (key === "symbols" && Array.isArray(value) && value.length === 0) {
        throw new Error(`missing_symbol: ${contract.name}: symbols is empty after normalize`);
      }
    }
  }
  return canonical;
}

export { extractSymbolArgs, requireSymbols };
