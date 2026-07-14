export type MarketScope = "US" | "CN" | "HK" | "CRYPTO" | "UNKNOWN";

export type ToolGovernanceDecision =
  | { allowed: true; market: MarketScope }
  | { allowed: false; market: MarketScope; reason: string; code: string };

type NegativeEntry = { reason: string; expiresAt: number };

const negativeCache = new Map<string, NegativeEntry>();
const NEGATIVE_TTL_MS = 10 * 60_000;

const US_ONLY_MCP_TOOLS = new Set([
  "get_8k_material_events",
  "get_13f_institutional_holdings",
  "get_13dg_ownership_changes",
  "get_sec_form4_filings",
  "get_insider_trades",
  "get_options_chain",
  "calculate_greeks",
  "calculate_max_pain",
  "get_implied_volatility",
]);

/** Infer market from the structured tool arguments, never from free-form prose. */
export function inferMarketScope(params: Record<string, unknown>): MarketScope {
  const candidates = [params.symbol, params.ticker, params.symbols]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toUpperCase());
  if (candidates.some((value) => /\.(SH|SS|SZ)$/.test(value))) return "CN";
  if (candidates.some((value) => /\.HK$/.test(value))) return "HK";
  if (candidates.some((value) => /(-USD|USDT)$/.test(value))) return "CRYPTO";
  if (candidates.some((value) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(value))) return "US";
  return "UNKNOWN";
}

export function evaluateToolGovernance(input: {
  workflowId: string;
  targetName: string;
  params: Record<string, unknown>;
}): ToolGovernanceDecision {
  purgeExpired();
  const market = inferMarketScope(input.params);
  const toolName = input.targetName.split("/").at(-1) ?? input.targetName;
  if (market !== "US" && market !== "UNKNOWN" && US_ONLY_MCP_TOOLS.has(toolName)) {
    return {
      allowed: false,
      market,
      code: "market_not_supported",
      reason: `工具 ${input.targetName} 仅适用于美国市场，当前识别为 ${market}；请改用当地交易所行情、公告或新闻工具。`,
    };
  }
  const cached = negativeCache.get(cacheKey(input.workflowId, input.targetName, market));
  if (cached) {
    return {
      allowed: false,
      market,
      code: "known_failure_in_workflow",
      reason: `本 workflow 已确认 ${input.targetName} 对 ${market} 不可用：${cached.reason}。禁止重复调用，请换 provider 或基于已有证据降级交付。`,
    };
  }
  return { allowed: true, market };
}

export function recordWorkflowToolFailure(input: {
  workflowId: string;
  targetName: string;
  params: Record<string, unknown>;
  reason: string;
  cacheable: boolean;
}): void {
  if (!input.cacheable) return;
  const market = inferMarketScope(input.params);
  negativeCache.set(cacheKey(input.workflowId, input.targetName, market), {
    reason: input.reason.slice(0, 240),
    expiresAt: Date.now() + NEGATIVE_TTL_MS,
  });
}

export function isToolNegativelyCached(
  workflowId: string,
  targetName: string,
  market: MarketScope
): boolean {
  purgeExpired();
  return negativeCache.has(cacheKey(workflowId, targetName, market));
}

export function resetToolGovernanceCacheForTest(): void {
  negativeCache.clear();
}

function cacheKey(workflowId: string, targetName: string, market: MarketScope): string {
  return `${workflowId}::${failureDomain(targetName)}::${market}`;
}

function failureDomain(targetName: string): string {
  const [provider = "builtin", rawTool = targetName] = targetName.includes("/")
    ? targetName.split("/", 2)
    : ["builtin", targetName];
  const tool = rawTool.toLowerCase();
  const dataKind = /news|sentiment/.test(tool)
    ? "news"
    : /fundamental|financial|earning|rating|peer|dcf/.test(tool)
      ? "fundamentals"
      : /quote|price|kline|bar|historical|indicator/.test(tool)
        ? "market"
        : tool;
  return `${provider}::${dataKind}`;
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [key, value] of negativeCache) {
    if (value.expiresAt <= now) negativeCache.delete(key);
  }
}
