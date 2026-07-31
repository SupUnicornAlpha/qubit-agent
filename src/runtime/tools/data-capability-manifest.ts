import { resolveTickerMarket, type MarketCode } from "../market/resolve-ticker-market";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";

export type DataCapabilityStatus = "available" | "unconfigured" | "no_coverage";

export type CapabilityManifestEntry = {
  toolName: string;
  status: DataCapabilityStatus;
  code:
    | "realtime_source_unconfigured"
    | "market_not_covered"
    | "fundamentals_source_unconfigured"
    | "news_source_unconfigured";
  provider: string | null;
  dataType: "realtime" | "historical" | "fundamentals" | "financials" | "news" | "other";
  freshnessMs: number | null;
  fallbackHistory: string[];
  reason: string;
};

export type RuntimeCapabilityManifest = {
  market: MarketCode | "UNKNOWN";
  tools: string[];
  unavailable: CapabilityManifestEntry[];
};

const REALTIME_TOOLS = new Set([
  "fetch_quote",
  "fetch_ticks",
  "fetch_order_book",
  "fetch_trades",
  "get_quote",
]);
const FUNDAMENTAL_TOOLS = new Set(["fetch_fundamentals", "fetch_financial_data"]);
const NEWS_TOOLS = new Set(["fetch_news", "fetch_news_sentiment"]);

export type RuntimeDataProviderSettings = {
  hasFundamentalsProvider?: boolean;
  hasNewsProvider?: boolean;
  newsSyntheticOnly?: boolean;
};

function canonicalToolName(toolName: string): string {
  return toolName.trim().toLowerCase().split("/").at(-1) ?? toolName.trim().toLowerCase();
}

/**
 * The native microstructure connector currently has realtime implementations
 * for CN and crypto only. Make that explicit before the prompt is constructed
 * rather than letting the model discover it through a costly failed call.
 */
export function buildRuntimeCapabilityManifest(input: {
  tools: string[];
  goal?: string | null;
  ticker?: string | null;
  symbol?: string | null;
  exchange?: string | null;
  providerSettings?: RuntimeDataProviderSettings;
}): RuntimeCapabilityManifest {
  const symbol = input.symbol?.trim() || input.ticker?.trim() || extractSymbolFromGoal(input.goal);
  const market = symbol
    ? resolveTickerMarket(symbol, input.exchange ? { hintExchange: input.exchange } : {}).market
    : "UNKNOWN";
  const unavailable: CapabilityManifestEntry[] = [];
  const tools: string[] = [];
  for (const toolName of input.tools) {
    const canonical = canonicalToolName(toolName);
    if (
      REALTIME_TOOLS.has(canonical) &&
      market !== "UNKNOWN" &&
      market !== "CN" &&
      market !== "CRYPTO"
    ) {
      unavailable.push({
        toolName,
        status: "unconfigured",
        code: "realtime_source_unconfigured",
        provider: "qubit-data",
        dataType: "realtime",
        freshnessMs: null,
        fallbackHistory: ["fetch_klines(timeframe=1m)", "fetch_klines(timeframe=5m)"],
        reason: `当前原生实时行情仅配置 CN/CRYPTO；${market} 市场不可调用 ${canonical}。请改用历史 K 线，或明确配置该市场的实时 provider。`,
      });
      continue;
    }
    if (
      FUNDAMENTAL_TOOLS.has(canonical) &&
      input.providerSettings?.hasFundamentalsProvider === false
    ) {
      unavailable.push({
        toolName,
        status: "unconfigured",
        code: "fundamentals_source_unconfigured",
        provider: "qubit-data",
        dataType: canonical === "fetch_fundamentals" ? "fundamentals" : "financials",
        freshnessMs: null,
        fallbackHistory: ["fetch_klines + technical snapshot", "configure fundamentals provider"],
        reason:
          "当前原生基本面/财务 connector 不提供可验证报表 periods；请配置 fundamentals provider，或只交付明确标注为价格/技术维度的分析。",
      });
      continue;
    }
    if (NEWS_TOOLS.has(canonical) && input.providerSettings?.hasNewsProvider === false) {
      unavailable.push({
        toolName,
        status: "unconfigured",
        code: "news_source_unconfigured",
        provider: "qubit-news",
        dataType: "news",
        freshnessMs: null,
        fallbackHistory: input.providerSettings.newsSyntheticOnly
          ? ["synthetic demo data is not research evidence", "configure news API provider"]
          : ["configure news API provider"],
        reason: input.providerSettings.newsSyntheticOnly
          ? "当前新闻 connector 只有 synthetic demo，不能作为研究证据。请配置新闻 provider。"
          : "当前新闻 connector 未配置 provider，不能作为研究证据。请配置新闻 API。",
      });
      continue;
    }
    tools.push(toolName);
  }
  return { market, tools, unavailable };
}

/**
 * Reads only connector configuration, never probes providers.  Prompt construction
 * stays deterministic while avoiding a doomed fundamentals/news call when no
 * evidence-grade provider has been configured.
 */
export async function buildRuntimeCapabilityManifestForRuntime(
  input: Omit<Parameters<typeof buildRuntimeCapabilityManifest>[0], "providerSettings">
): Promise<RuntimeCapabilityManifest> {
  try {
    const settings = await loadBuiltinConnectorSettings();
    const data = settings["qubit-data"] ?? {};
    const news = settings["qubit-news"] ?? {};
    const fundamentalsToken = data.tushareToken;
    const newsApiBaseUrl = news.newsApiBaseUrl;
    const synthetic = news.syntheticWhenEmpty === true || news.syntheticWhenEmpty === "true";
    return buildRuntimeCapabilityManifest({
      ...input,
      providerSettings: {
        // Native fetchFundamentals intentionally returns empty periods; only an
        // explicitly configured provider may be advertised as evidence-grade.
        hasFundamentalsProvider:
          typeof fundamentalsToken === "string" && fundamentalsToken.trim().length > 0,
        hasNewsProvider: typeof newsApiBaseUrl === "string" && newsApiBaseUrl.trim().length > 0,
        newsSyntheticOnly: synthetic,
      },
    });
  } catch {
    // Configuration read failure must not make a normal workflow unusable. The
    // existing runtime gate and actual connector errors remain authoritative.
    return buildRuntimeCapabilityManifest(input);
  }
}

export function isToolBlockedByRuntimeCapability(
  manifest: RuntimeCapabilityManifest,
  toolName: string
): CapabilityManifestEntry | null {
  const canonical = canonicalToolName(toolName);
  return (
    manifest.unavailable.find((entry) => canonicalToolName(entry.toolName) === canonical) ?? null
  );
}

export function renderRuntimeCapabilityManifest(manifest: RuntimeCapabilityManifest): string {
  if (manifest.unavailable.length === 0) return "";
  return [
    "## 本轮数据能力清单（运行时已验证）",
    `- 识别市场：${manifest.market}`,
    ...manifest.unavailable.map(
      (entry) => `- 不可用：${entry.toolName}（${entry.status}/${entry.code}）— ${entry.reason}`
    ),
    "- 不可用工具不会出现在候选列表；不得通过原样重试将其当作数据缺失的解决方案。",
  ].join("\n");
}

function extractSymbolFromGoal(goal?: string | null): string | null {
  if (!goal) return null;
  const match = goal.match(/\b(?:[A-Z]{1,5}|\d{6}(?:\.(?:SH|SZ|BJ))?)\b/);
  return match?.[0] ?? null;
}
