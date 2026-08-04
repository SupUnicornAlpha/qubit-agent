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
  /(fetch_klines|fetch_bars|get_klines|klines|fetch_quote|get_quote|fetch_price|price_data|market\.resolve_symbol|resolve_symbol)/i;
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

/** 从 requestJson / 常见 params 包装里抽 symbol / exchange。 */
export function extractMarketRefFromToolPayload(payload: unknown): {
  symbol: string | null;
  exchange: string | null;
} {
  const root = asRecord(payload);
  const params = asRecord(root?.params) ?? asRecord(root?.arguments) ?? asRecord(root?.input) ?? root;
  const nested = asRecord(params?.params) ?? asRecord(params?.query);
  const bag = nested ?? params;
  return {
    symbol: pickString(bag, ["symbol", "ticker", "code", "sec_id", "instrument", "underlying"]),
    exchange: pickString(bag, ["exchange", "market", "exch", "mic"]),
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
    const ref = extractMarketRefFromToolPayload(t.requestJson);
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
    const ref = extractMarketRefFromToolPayload(m.requestJson);
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
