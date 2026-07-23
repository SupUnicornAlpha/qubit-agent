/**
 * mcp-financex Fallback Router (P0-2, Round 6 复盘新增 2026-06-08)
 *
 * 背景：mcp-financex 1.0.x 在 Yahoo 403 / validation_error 时频繁 exit(1)，
 * 导致整个 server 熔断 → 当一次 batch 内 9/9 调用全 fail-fast。
 * `mcp-financex-process-guard.mjs` 已经兜住部分 unhandledRejection，但对 schema
 * 校验错 / yahoo 限流 无能为力。
 *
 * 这层 fallback 在 server 已熔断 OR 单工具调用失败时，把以下"可平移工具"
 * 自动 rewrite 到内置 connector（不经 MCP 子进程，零 cold-start，零崩溃风险）：
 *
 *   mcp-financex/get_quote          → qubit-data 最新一条 K 线（用 close 当 quote）
 *   mcp-financex/get_quote_batch    → 批量 qubit-data
 *   mcp-financex/get_historical_data→ qubit-data 完整 OHLCV
 *   mcp-financex/get_market_news    → qubit-news fetch_news_sentiment 的简化版
 *
 * 设计原则：
 *   - **零参数 schema 修改**：保持 financex 入参字段（symbol / start_date / end_date / limit），
 *     避免 LLM 还要重学一遍调用方式
 *   - **返回 shape 尽量贴近 financex**：保留 symbol / price / open / high / low / close /
 *     volume / timestamp / headline / source 等字段，让 reasonText 解析逻辑不破
 *   - **失败可上抛**：fallback 自己也可能失败（如 Yahoo 同样限流），原始 error 透传
 *
 * 显式不做：
 *   - 不做 financex 专有工具的 fallback（如 get_options_chain / get_13f_holdings 等结构化产品），
 *     这些 connector 本来就没数据源，跳过让 LLM 看到原始错误并改用 explore 路径
 */

import { queryBarsRange } from "../market/klines-query";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import type { McpDispatchResult } from "./dispatcher";

/** 可以走 fallback 的 financex 工具白名单（其余抛原始错误） */
export const FINANCEX_FALLBACK_TOOLS = new Set([
  "get_quote",
  "get_quote_batch",
  "get_historical_data",
  "get_market_news",
]);

/** 入参里抽 symbol（financex 不同工具字段名略不同：symbol / ticker / symbols / tickers） */
function pickSymbols(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const key of ["symbol", "ticker"]) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) out.add(v.trim().toUpperCase());
  }
  for (const key of ["symbols", "tickers"]) {
    const v = args[key];
    if (Array.isArray(v)) {
      for (const s of v) {
        if (typeof s === "string" && s.trim()) out.add(s.trim().toUpperCase());
      }
    }
  }
  return Array.from(out);
}

function pickStringField(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/** YYYY-MM-DD：今天 / N 天前 */
function dateNDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** financex get_quote / get_quote_batch fallback */
async function fallbackGetQuote(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const symbols = pickSymbols(args);
  if (symbols.length === 0) {
    throw new Error("financex_fallback get_quote: 必须传 symbol / ticker / symbols / tickers 之一");
  }

  /**
   * "quote" 语义：拿最近一根日 K 的 close + 当日 OHLCV 当成 quote。
   * fetch 30 天范围保证至少有 1 根（覆盖长周末 + 假期）。
   */
  const startDate = dateNDaysAgo(30);
  const endDate = todayIso();
  const quotes: Array<Record<string, unknown>> = [];
  for (const sym of symbols) {
    try {
      const bars = await queryBarsRange({
        symbol: sym,
        exchange: "",
        period: "1d",
        startDate,
        endDate,
      });
      if (bars.length === 0) {
        quotes.push({
          symbol: sym,
          error: "no_bars",
          fallback_source: "qubit-data/yahoo",
        });
        continue;
      }
      const latest = bars[bars.length - 1]!;
      quotes.push({
        symbol: sym,
        price: latest.close,
        last_price: latest.close,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume,
        timestamp: latest.timestamp,
        bar_date: latest.timestamp.slice(0, 10),
        fallback_source: "qubit-data/yahoo",
      });
    } catch (err) {
      quotes.push({
        symbol: sym,
        error: (err as Error).message,
        fallback_source: "qubit-data/yahoo",
      });
    }
  }

  return symbols.length === 1 ? (quotes[0] ?? {}) : { quotes, count: quotes.length };
}

/** financex get_historical_data fallback */
async function fallbackGetHistoricalData(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const symbols = pickSymbols(args);
  if (symbols.length === 0) {
    throw new Error("financex_fallback get_historical_data: 必须传 symbol / ticker");
  }
  const sym = symbols[0]!;
  const startDate = pickStringField(args, "start_date", "from", "from_date") ?? dateNDaysAgo(365);
  const endDate = pickStringField(args, "end_date", "to", "to_date") ?? todayIso();
  /**
   * financex 用 interval 字段（1d/1h/...）；我们只支持日线 fallback —— 高频 fallback
   * 数据源太昂贵，不在 P0 范围。如果 LLM 传了非 1d，会被忽略，依然返 1d 数据，
   * 但带一个 warning 字段让它感知。
   */
  const interval = pickStringField(args, "interval", "period") ?? "1d";
  const isDaily = interval === "1d" || interval === "day";

  const bars = await queryBarsRange({
    symbol: sym,
    exchange: "",
    period: "1d",
    startDate,
    endDate,
  });

  return {
    symbol: sym,
    interval: "1d",
    bars: bars.map((b) => ({
      timestamp: b.timestamp,
      date: b.timestamp.slice(0, 10),
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    })),
    count: bars.length,
    fallback_source: "qubit-data/yahoo",
    ...(isDaily
      ? {}
      : { warning: `financex_fallback only supports daily; ignored interval=${interval}` }),
  };
}

/** financex get_market_news fallback */
async function fallbackGetMarketNews(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const symbols = pickSymbols(args);
  if (symbols.length === 0) {
    throw new Error("financex_fallback get_market_news: 必须传 symbol / ticker");
  }
  const sym = symbols[0]!;
  const limitRaw = args["limit"];
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 12;

  const requestedMode = pickStringField(args, "mode", "news_mode");
  const mode = requestedMode === "historical_validation" ? requestedMode : "current";
  const aliases = [
    pickStringField(args, "company_name", "companyName", "name"),
    ...(Array.isArray(args["keywords"])
      ? args["keywords"].filter((value): value is string => typeof value === "string")
      : []),
  ].filter((value): value is string => Boolean(value));
  const brief = await queryMarketNewsBrief({ symbol: sym, exchange: "", limit, mode, aliases });
  if (brief.symbolNews.length === 0) {
    const rejectionSummary = brief.evidence
      ? Object.entries(brief.evidence.rejected)
          .filter(([, count]) => count > 0)
          .map(([reason, count]) => `${reason}=${count}`)
          .join(",")
      : "none_accepted";
    throw new Error(
      `news_evidence_unavailable: no ${mode === "current" ? "fresh relevant" : "relevant"} ` +
        `news for ${sym}; rejected=${rejectionSummary || "none_accepted"}`
    );
  }
  const headlines = [...brief.symbolNews, ...brief.sectorNews].slice(0, limit).map((item) => ({
    headline: item.title,
    title: item.title,
    source: item.source ?? null,
    url: item.url ?? null,
    timestamp: item.publishedAt ?? null,
    /** financex 通常返回 sentiment，这里没源 → 不带，留给 LLM 在 reasonText 中自评 */
    snippet: item.content?.slice(0, 200) ?? "",
  }));

  return {
    symbol: sym,
    news: headlines,
    headlines,
    count: headlines.length,
    sector: brief.sectorLabel,
    evidence: brief.evidence,
    fallback_source: "qubit-news/yahoo+connector",
  };
}

/**
 * 主入口：根据工具名跳到具体 fallback 实现，组装成与正常 dispatch 一致的 shape。
 * 若工具名不在白名单 → 返回 null，caller 应该抛原 error 不做 fallback。
 */
export async function tryFinancexFallback(input: {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  reason: "circuit_open" | "tool_error";
  originalError?: Error;
}): Promise<McpDispatchResult | null> {
  if (input.serverName !== "mcp-financex") return null;
  if (!FINANCEX_FALLBACK_TOOLS.has(input.toolName)) return null;

  const args = input.arguments ?? {};
  let output: Record<string, unknown>;
  switch (input.toolName) {
    case "get_quote":
    case "get_quote_batch":
      output = await fallbackGetQuote(args);
      break;
    case "get_historical_data":
      output = await fallbackGetHistoricalData(args);
      break;
    case "get_market_news":
      output = await fallbackGetMarketNews(args);
      break;
    default:
      return null;
  }

  /** 在 output 顶层加 fallback 元数据，让 LLM / 日志能知道这是 fallback 路径 */
  return {
    serverName: input.serverName,
    toolName: input.toolName,
    transport: "stdio", // 保留原 transport 字段不变，便于上层日志解析
    accepted: true,
    output: {
      ...output,
      __mcp_fallback: {
        original_server: input.serverName,
        original_tool: input.toolName,
        reason: input.reason,
        original_error: input.originalError?.message ?? null,
        routed_to: input.toolName === "get_market_news" ? "qubit-news" : "qubit-data",
      },
    },
  };
}
