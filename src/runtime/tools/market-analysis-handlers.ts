import { computeDateRangeForLimit, queryBarsRange } from "../market/klines-query";
import { getMarketDataReadiness } from "../market/market-data-health";
import { listMarketDataSources } from "../market/market-data-source-control";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { extractSymbolArgs, requireSymbols } from "../market/normalize-symbol-args";
import { detectRegimeFromBars } from "../market/regime";
import { resolveTickerMarket } from "../market/resolve-ticker-market";
import {
  computeBollinger,
  computeMacd,
  computeRsi,
  computeSma,
  snapshotIndicators,
} from "../market/technical-indicators";
import { applyToolContract, isToolContractEnabled } from "./tool-contract";
import { getToolContract } from "./tool-contract-registry";
import type { BuiltinToolHandler } from "./types";

/** Read-only market lookup and deterministic indicator-analysis handlers. */
export const MARKET_ANALYSIS_HANDLERS: Record<string, BuiltinToolHandler> = {
  "market.resolve_symbol": async (_ctx, params) => {
    const contract = isToolContractEnabled() ? getToolContract("market.resolve_symbol") : undefined;
    const canonical = contract ? applyToolContract(contract, params) : params;
    const symbols =
      Array.isArray(canonical.symbols) && canonical.symbols.length > 0
        ? (canonical.symbols as string[])
        : extractSymbolArgs(canonical);
    if (symbols.length === 0) {
      requireSymbols(params, { arity: "either", toolName: "market.resolve_symbol" });
    }
    const hint =
      typeof canonical.exchange === "string" ? { hintExchange: canonical.exchange as string } : {};
    const results = symbols.map((symbol) => resolveTickerMarket(symbol, hint));
    const singleResult = results.at(0);
    return results.length === 1 && singleResult ? singleResult : { results, count: results.length };
  },

  "market.data_sources": async (_ctx, params) => {
    const market = typeof params.market === "string" ? params.market.toUpperCase() : "";
    const timeframe = typeof params.timeframe === "string" ? params.timeframe : "";
    const rows = await listMarketDataSources();
    return {
      readiness: getMarketDataReadiness(),
      readinessScope: "historical_and_realtime",
      dispatchReadiness: "not_checked",
      sources: rows.filter(
        (row) =>
          (!market || row.supportedMarkets.includes(market)) &&
          (!timeframe || row.supportedTimeframes.includes(timeframe))
      ),
      guidance:
        "先用 market.resolve_symbol 确认市场。实时/现价请求必须先看 realtimeReadyMarkets 并调用 fetch_quote；历史 K 线再调用 fetch_klines。不要用 readyMarkets（日线能力）冒充实时能力，也不要原样重复调用已 open/down 的源。此结果不代表 call_team_* 调度健康。",
    };
  },

  "market.readiness": async () => getMarketDataReadiness(),

  compute_indicators: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("compute_indicators: symbol is required");
    const exchange = String(params.exchange ?? "");
    const timeframe = String(params.timeframe ?? "1d");
    const limit = Math.max(30, Math.min(Number(params.limit ?? 120), 500));
    const { period, startDate, endDate } = computeDateRangeForLimit(timeframe, limit);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const closes = bars.map((bar) => bar.close);
    return {
      symbol,
      barCount: bars.length,
      snapshot: snapshotIndicators(bars, symbol),
      series: {
        sma20: computeSma(closes, 20).slice(-5),
        rsi14: computeRsi(closes, 14).slice(-5),
        macd: computeMacd(closes).macd.slice(-5),
        bollinger: {
          upper: computeBollinger(closes).upper.slice(-5),
          lower: computeBollinger(closes).lower.slice(-5),
        },
      },
    };
  },

  detect_patterns: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("detect_patterns: symbol is required");
    const exchange = String(params.exchange ?? "");
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 120);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const regime = detectRegimeFromBars(bars);
    const closes = bars.map((bar) => bar.close);
    const fast = computeSma(closes, 5);
    const slow = computeSma(closes, 20);
    const index = closes.length - 1;
    const previousFast = fast[index - 1] ?? Number.NaN;
    const previousSlow = slow[index - 1] ?? Number.NaN;
    const currentFast = fast[index] ?? Number.NaN;
    const currentSlow = slow[index] ?? Number.NaN;
    const goldenCross =
      index >= 1 &&
      Number.isFinite(currentFast) &&
      Number.isFinite(currentSlow) &&
      previousFast <= previousSlow &&
      currentFast > currentSlow;
    const deathCross =
      index >= 1 &&
      Number.isFinite(currentFast) &&
      Number.isFinite(currentSlow) &&
      previousFast >= previousSlow &&
      currentFast < currentSlow;
    return {
      symbol,
      regime,
      patterns: [
        ...(goldenCross ? [{ name: "golden_cross", strength: 0.7 }] : []),
        ...(deathCross ? [{ name: "death_cross", strength: 0.7 }] : []),
      ],
    };
  },

  compute_valuation: async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.ticker ?? "").trim();
    if (!symbol) throw new Error("compute_valuation: symbol is required");
    const exchange = String(params.exchange ?? "");
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 252);
    const bars = await queryBarsRange({ symbol, exchange, period, startDate, endDate });
    const closes = bars.map((bar) => bar.close);
    const last = closes.at(-1) ?? 0;
    const mean252 =
      closes.length > 0 ? closes.reduce((sum, close) => sum + close, 0) / closes.length : last;
    return {
      symbol,
      lastClose: last,
      meanPrice252d: mean252,
      peProxy: mean252 > 0 ? last / mean252 : null,
      note: "PE 为价格/252日均价的简化代理，非真实财报 PE；接入财报数据后可替换",
    };
  },

  compute_macro_indicators: async (_ctx, params) => {
    const benchmark = String(params.benchmark ?? params.symbol ?? "000300");
    const exchange = String(params.exchange ?? "SH");
    const { period, startDate, endDate } = computeDateRangeForLimit("1d", 120);
    const bars = await queryBarsRange({ symbol: benchmark, exchange, period, startDate, endDate });
    const regime = detectRegimeFromBars(bars);
    return {
      benchmark,
      regime: regime.regime,
      features: regime.features,
      riskAppetite:
        regime.regime.includes("uptrend") || regime.regime === "drift_up"
          ? "risk_on"
          : regime.regime.includes("down") || regime.regime === "high_volatility"
            ? "risk_off"
            : "neutral",
    };
  },

  fetch_macro_data: async (ctx, params) => {
    const handler = MARKET_ANALYSIS_HANDLERS.compute_macro_indicators;
    if (!handler) throw new Error("compute_macro_indicators is not registered");
    return handler(ctx, params);
  },

  analyze_social_media: async (_ctx, params) => {
    const keywords = Array.isArray(params.keywords)
      ? params.keywords.map(String)
      : [String(params.symbol ?? params.ticker ?? "")];
    const brief = await queryMarketNewsBrief({
      symbol: keywords[0] ?? "",
      exchange: String(params.exchange ?? ""),
      limit: 8,
    });
    const items = [...brief.symbolNews, ...brief.sectorNews];
    return {
      keywords,
      discussionVolume: items.length,
      headlines: items.slice(0, 5).map((item) => item.title),
      note: "基于新闻头条的舆情代理；完整社交数据需外接 API",
    };
  },
};
