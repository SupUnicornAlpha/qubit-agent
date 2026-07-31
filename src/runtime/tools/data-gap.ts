import { inferMarketScope } from "./tool-governance-policy";

export type DataGapKind =
  | "unconfigured"
  | "no_coverage"
  | "no_data"
  | "transient"
  | "invalid_request"
  | "not_attempted";

export type DataGap = {
  kind: DataGapKind;
  capability: string;
  market: string;
  provider: string | null;
  reason: string;
  retryable: boolean;
};

const REQUIRED_TOOL_ALIASES: Record<string, readonly string[]> = {
  get_quote: ["get_quote", "quote", "price", "klines", "bars"],
  news: ["news", "headline", "filing", "earnings", "announcement"],
  screener: ["screener", "run_screener", "stock_screen", "screen_stocks"],
  "recommendation.record": [
    "recommendation.record",
    "recommendation_record",
    "record_recommendation",
  ],
  factor: ["factor", "factor.register", "factor.compute", "factor.autoevaluate"],
  strategy: ["strategy", "strategy.create", "strategy.compose", "strategy.create_version"],
  order: ["order", "submit_order", "order_intent", "create_intent"],
  risk: ["risk", "rule.evaluate", "risk_decision", "risk.check"],
};

export function toolMatchesRequiredCapability(toolName: string, required: string): boolean {
  const normalized = toolName.toLowerCase();
  const aliases = REQUIRED_TOOL_ALIASES[required] ?? [required];
  return aliases.some((alias) => normalized.includes(alias.toLowerCase()));
}

/**
 * `not_attempted` is deliberately generated from the scenario contract rather
 * than an empty connector response. It prevents a final answer from turning
 * "we never asked the provider" into "there was no data".
 */
export function buildNotAttemptedDataGaps(input: {
  requiredCapabilities: readonly string[];
  attemptedTools: readonly string[];
  market?: string | null;
}): DataGap[] {
  return input.requiredCapabilities
    .filter(
      (required) =>
        !input.attemptedTools.some((toolName) => toolMatchesRequiredCapability(toolName, required))
    )
    .map((capability) => ({
      kind: "not_attempted" as const,
      capability,
      market: input.market?.trim() || "UNKNOWN",
      provider: null,
      reason: `场景要求的能力 ${capability} 在本 workflow 中从未调用；这不是无数据或无覆盖的证据。`,
      retryable: true,
    }));
}

/**
 * Translate heterogeneous provider / connector errors into product semantics.
 * This is intentionally conservative: an unknown tool error remains an error,
 * not a fabricated DataGap.
 */
export function classifyDataGap(input: {
  toolName: string;
  params: Record<string, unknown>;
  message: string;
}): DataGap | null {
  const raw = input.message.trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const capability = input.toolName;
  const market = inferMarketScope(input.params);
  const provider = providerFromToolName(input.toolName);

  if (
    /not configured|no eligible source|source is not configured|mcp_server_disabled/.test(lower)
  ) {
    return gap("unconfigured", false);
  }
  if (
    /currently supports|only supports|market_not_supported|unsupported market|periods_empty|no coverage/.test(
      lower
    )
  ) {
    return gap("no_coverage", false);
  }
  if (
    /items_empty|semantic_empty_result|bar_count_zero|no_bars|no_data|items? empty|empty results/.test(
      lower
    )
  ) {
    return gap("no_data", false);
  }
  if (
    /missing_symbol|validation|invalid (?:argument|parameter|input)|is required|contract_validation/.test(
      lower
    )
  ) {
    return gap("invalid_request", false);
  }
  if (
    /timeout|timed out|etimedout|econnreset|eai_again|network|transport closed|all .*source\(s\) failed/.test(
      lower
    )
  ) {
    return gap("transient", true);
  }
  return null;

  function gap(kind: DataGapKind, retryable: boolean): DataGap {
    return { kind, capability, market, provider, reason: raw.slice(0, 1_000), retryable };
  }
}

function providerFromToolName(toolName: string): string | null {
  const slash = toolName.indexOf("/");
  if (slash > 0) return toolName.slice(0, slash);
  if (toolName.startsWith("mcp:")) return toolName.slice(4).split(".")[0] ?? null;
  return null;
}
