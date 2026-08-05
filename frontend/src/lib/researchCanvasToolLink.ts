/**
 * 研究画布「工具联动」：从 team-graph 工具调用里识别行情/新闻类工具，
 * 并抽出 symbol/exchange，供中栏切到 K 线/新闻视图时定位标的。
 *
 * 不钉死角色或 connector 清单——用工具名模式匹配，新工具只要命名语义接近即可命中。
 */
import type { AnalystTeamGraphToolCall, AnalystTeamGraphMcpCall } from "../api/types";

export type ResearchCanvasToolKind = "market" | "news" | "other";

export type ResearchCanvasToolHit = {
  id: string;
  kind: ResearchCanvasToolKind;
  toolName: string;
  agentRole: string;
  status: string;
  createdAt: string;
  symbol: string | null;
  exchange: string | null;
  latencyMs: number | null;
  errorMessage: string | null;
  requestJson?: unknown;
  responseJson?: unknown;
};

const MARKET_TOOL_RE =
  /(fetch_klines|fetch_bars|get_klines|klines|fetch_quote|get_quote|fetch_price|price_data|market\.resolve_symbol|market\.snapshot|resolve_symbol|technical_indicator|historical_prices)/i;
const NEWS_TOOL_RE = /(fetch_news|get_news|news_brief|market_news|news\.|headline)/i;

export function classifyResearchCanvasToolName(toolName: string): ResearchCanvasToolKind {
  const name = toolName.trim();
  if (!name) return "other";
  if (NEWS_TOOL_RE.test(name)) return "news";
  if (MARKET_TOOL_RE.test(name)) return "market";
  return "other";
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | null {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

const SYMBOL_KEYS = ["symbol", "ticker", "code", "sec_id", "instrument", "underlying"];
const EXCHANGE_KEYS = ["exchange", "market", "exch", "mic", "venue"];

function pickRef(bag: Record<string, unknown> | null): {
  symbol: string | null;
  exchange: string | null;
} {
  return {
    symbol: pickString(bag, SYMBOL_KEYS),
    exchange: pickString(bag, EXCHANGE_KEYS),
  };
}

/**
 * 从 requestJson / 常见 params 包装里抽 symbol / exchange。
 * 兼容：
 * - `{ params|arguments|input: { symbol } }`
 * - Prime Core / tool_call_log：`{ contextMemory: { args: { symbol } } }`
 * - 模型再包一层：`{ arguments: { ticker } }`
 */
export function extractMarketRefFromToolPayload(payload: unknown): {
  symbol: string | null;
  exchange: string | null;
} {
  const root = asRecord(payload);
  const contextMemory = asRecord(root?.contextMemory);
  const cmArgs = asRecord(contextMemory?.args);
  const params =
    asRecord(root?.params) ??
    asRecord(root?.arguments) ??
    asRecord(root?.input) ??
    cmArgs ??
    root;

  const nested =
    asRecord(params?.params) ??
    asRecord(params?.arguments) ??
    asRecord(params?.query) ??
    null;

  // 顶层优先，嵌套补缺
  const top = pickRef(params);
  const deep = pickRef(nested);
  return {
    symbol: top.symbol ?? deep.symbol,
    exchange: top.exchange ?? deep.exchange,
  };
}

/** 从工具响应补抽标的（如 market.snapshot.get → qualityVerdict.instrument）。 */
export function extractMarketRefFromToolResponse(payload: unknown): {
  symbol: string | null;
  exchange: string | null;
} {
  const root = asRecord(payload);
  const quality = asRecord(root?.qualityVerdict);
  const instrument =
    asRecord(root?.instrument) ?? asRecord(quality?.instrument) ?? null;
  const top = pickRef(root);
  const fromInst = pickRef(instrument);
  return {
    symbol: top.symbol ?? fromInst.symbol,
    exchange: top.exchange ?? fromInst.exchange,
  };
}

export function buildResearchCanvasToolHits(input: {
  toolCalls?: AnalystTeamGraphToolCall[] | null;
  mcpCalls?: AnalystTeamGraphMcpCall[] | null;
  limit?: number;
}): ResearchCanvasToolHit[] {
  const limit = input.limit ?? 80;
  const hits: ResearchCanvasToolHit[] = [];

  for (const t of input.toolCalls ?? []) {
    const kind = classifyResearchCanvasToolName(t.toolName);
    let ref = extractMarketRefFromToolPayload(t.requestJson);
    if (!ref.symbol) {
      const fromResp = extractMarketRefFromToolResponse(t.responseJson);
      ref = {
        symbol: fromResp.symbol,
        exchange: ref.exchange ?? fromResp.exchange,
      };
    }
    hits.push({
      id: `tool:${t.id}`,
      kind,
      toolName: t.toolName,
      agentRole: t.agentRole,
      status: t.status,
      createdAt: t.createdAt,
      symbol: ref.symbol,
      exchange: ref.exchange,
      latencyMs: t.latencyMs,
      errorMessage: t.errorMessage ?? null,
      requestJson: t.requestJson,
      responseJson: t.responseJson,
    });
  }

  for (const m of input.mcpCalls ?? []) {
    const fullName = `${m.serverName}/${m.toolName}`;
    const kind = classifyResearchCanvasToolName(fullName);
    let ref = extractMarketRefFromToolPayload(m.requestJson);
    if (!ref.symbol) {
      const fromResp = extractMarketRefFromToolResponse(m.responseJson);
      ref = {
        symbol: fromResp.symbol,
        exchange: ref.exchange ?? fromResp.exchange,
      };
    }
    hits.push({
      id: `mcp:${m.id}`,
      kind,
      toolName: fullName,
      agentRole: m.agentRole,
      status: m.status,
      createdAt: m.createdAt,
      symbol: ref.symbol,
      exchange: ref.exchange,
      latencyMs: m.latencyMs,
      errorMessage: m.errorCode ?? null,
      requestJson: m.requestJson,
      responseJson: m.responseJson,
    });
  }

  return hits
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, limit);
}

/** 最近一次成功的行情/新闻类调用，用于自动联动 chartSpec。 */
export function latestSuccessfulMarketLink(
  hits: ResearchCanvasToolHit[]
): ResearchCanvasToolHit | null {
  for (const h of hits) {
    if (h.status !== "success") continue;
    if (h.kind !== "market" && h.kind !== "news") continue;
    if (!h.symbol) continue;
    return h;
  }
  return null;
}
