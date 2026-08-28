import {
  canonicalCalendarSessions,
  getOrCreateMarketSnapshot,
  isMarketSnapshotGetEnabled,
} from "../market/contracts/market-snapshot-service";
import {
  MarketCorporateActionLedgerSchema,
  MarketFundamentalLedgerSchema,
  MarketUniverseHistorySchema,
} from "../market/contracts/market-event-v2";
import { loadBuiltinConnectorSettings } from "../config/builtin-connector-settings";
import { computeDateRangeForLimit, queryBarsRange } from "../market/klines-query";
import { getMarketDataReadiness } from "../market/market-data-health";
import { listMarketDataSources } from "../market/market-data-source-control";
import { queryMarketNewsBrief } from "../market/news-brief-query";
import { queryMarketQuote } from "../market/microstructure-query";
import { fetchOptionChain, type OptionChainRequestSource } from "../market/options-chain";
import {
  analyzeOptionStrategy,
  isOptionStrategyName,
  type OptionStrategyInput,
  type StrategyLegInput,
} from "../market/options-strategy";
import { extractSymbolArgs, requireSymbols } from "../market/normalize-symbol-args";
import { detectRegimeFromBars } from "../market/regime";
import { resolveTickerMarket } from "../market/resolve-ticker-market";
import { getIdeMarketSubscriptions, getMarketWatchlist } from "../market/watchlist-service";
import { marketStreamGateway } from "../market/market-stream-gateway";
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
  /**
   * User's local IDE subscription list + only the quote values already pushed
   * into the IDE stream. This is deliberately a no-network read: it gives an
   * Agent the exact meaning of “my watchlist” without turning memory into a
   * market-data source or silently querying a broker/public provider.
   */
  "market.ide_subscription.get": async () => {
    const subscription = await getIdeMarketSubscriptions();
    const entries = subscription.entries.map((entry) => {
      const cachedQuote = marketStreamGateway.getCachedQuote(entry);
      return {
        ...entry,
        cachedQuote,
        quoteState: cachedQuote ? "ide_stream_cached" : "not_in_ide_stream_cache",
      };
    });
    return {
      source: subscription.source,
      networkAccessed: false,
      entries,
      count: entries.length,
      stream: marketStreamGateway.snapshot(),
      guidance:
        "这是 IDE 本机自选与已到达的订阅缓存，不读取 Agent 记忆、不调用券商也不访问公共行情。需要券商实时行情时，明确对其中的 symbols 调用 market.broker_quote.get。",
    };
  },

  /**
   * Explicit one-shot broker quote read. It requires a configured bridge and
   * never degrades into Eastmoney/Yahoo/etc., so its source semantics remain
   * auditable and distinct from the IDE subscription cache.
   */
  "market.broker_quote.get": async (_ctx, params) => {
    const symbols = requireSymbols(params, {
      arity: "either",
      toolName: "market.broker_quote.get",
    });
    const requestedExchange = typeof params.exchange === "string" ? params.exchange : undefined;
    const provider =
      typeof params.provider === "string"
        ? params.provider
        : typeof params.bridge === "string"
          ? params.bridge
          : undefined;
    const timeoutCandidate = Number(params.timeoutMs ?? params.timeout_ms ?? 5_000);
    const timeoutMs = Math.max(
      1_000,
      Math.min(Number.isFinite(timeoutCandidate) ? timeoutCandidate : 5_000, 15_000)
    );
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => {
        const resolution = resolveTickerMarket(symbol, {
          ...(requestedExchange ? { hintExchange: requestedExchange } : {}),
        });
        const quote = await marketStreamGateway.requestBrokerQuote(
          {
            symbol: resolution.symbol,
            exchange: resolution.exchange,
            ...(provider ? { provider } : {}),
          },
          timeoutMs
        );
        return { ...quote, market: resolution.market };
      })
    );
    const quotes = results.flatMap((row) => (row.status === "fulfilled" ? [row.value] : []));
    const errors = results.flatMap((row, index) =>
      row.status === "rejected"
        ? [
            {
              symbol: symbols[index] ?? "",
              error: row.reason instanceof Error ? row.reason.message : String(row.reason),
            },
          ]
        : []
    );
    return {
      source: "broker_market_bridge",
      networkAccessed: true,
      fallbackUsed: false,
      quotes,
      errors,
      count: quotes.length,
      guidance:
        "只接受已配置券商/交易桥的推送；桥未配置、无权限或超时会直接返回 error，绝不降级为公共行情源。",
    };
  },

  /**
   * A local, read-only options strategy module. It fetches the chain needed for
   * the requested template and returns deterministic P&L/Greeks; it never
   * creates an order intent or uses a public fallback as a broker quote.
   */
  "market.options.strategy_analyze": async (_ctx, params) => {
    const symbol = String(params.symbol ?? params.underlying ?? "").trim();
    if (!symbol) throw new Error("market.options.strategy_analyze: symbol is required");
    const strategy = String(params.strategy ?? "single")
      .trim()
      .toLowerCase();
    if (!isOptionStrategyName(strategy))
      throw new Error("market.options.strategy_analyze: invalid strategy");
    const sourceRaw = String(params.source ?? "auto")
      .trim()
      .toLowerCase();
    if (!["auto", "futu", "alpaca", "research"].includes(sourceRaw)) {
      throw new Error(
        "market.options.strategy_analyze: source must be auto, futu, alpaca, or research"
      );
    }
    const exchange = typeof params.exchange === "string" ? params.exchange.trim() : "";
    const expiry = typeof params.expiry === "string" ? params.expiry.trim() : "";
    const requestedFarExpiry = typeof params.farExpiry === "string" ? params.farExpiry.trim() : "";
    const settings = await loadBuiltinConnectorSettings();
    const source = sourceRaw as OptionChainRequestSource;
    const chain = await fetchOptionChain({
      symbol,
      ...(exchange ? { exchange } : {}),
      ...(expiry ? { expiry } : {}),
      source,
      settings,
    });
    const needsFarExpiry = strategy === "calendar" || strategy === "diagonal";
    const farExpiry =
      requestedFarExpiry || chain.expirations.find((value) => !expiry || !value.startsWith(expiry));
    const farChain =
      needsFarExpiry && farExpiry
        ? await fetchOptionChain({
            symbol,
            ...(exchange ? { exchange } : {}),
            expiry: farExpiry,
            source,
            settings,
          })
        : null;
    const quote = await queryMarketQuote({ symbol, ...(exchange ? { exchange } : {}) }).catch(
      () => null
    );
    const numberParam = (key: string) => {
      const value = Number(params[key]);
      return Number.isFinite(value) ? value : undefined;
    };
    const input: OptionStrategyInput = {
      strategy,
      ...(numberParam("centerStrike") !== undefined
        ? { centerStrike: numberParam("centerStrike") }
        : {}),
      ...(numberParam("widthSteps") !== undefined ? { widthSteps: numberParam("widthSteps") } : {}),
      ...(numberParam("quantity") !== undefined ? { quantity: numberParam("quantity") } : {}),
      ...(params.singleRight === "call" || params.singleRight === "put"
        ? { singleRight: params.singleRight }
        : {}),
      ...(params.singleSide === "buy" || params.singleSide === "sell"
        ? { singleSide: params.singleSide }
        : {}),
      ...(params.direction === "bullish" || params.direction === "bearish"
        ? { direction: params.direction }
        : {}),
      ...(Array.isArray(params.legs) ? { legs: parseOptionStrategyLegs(params.legs) } : {}),
    };
    const analysis = analyzeOptionStrategy(
      input,
      farChain ? [chain, farChain] : [chain],
      quote?.lastPrice ?? null
    );
    return {
      ...analysis,
      underlying: chain.underlying,
      spot: quote?.lastPrice ?? null,
      source: chain.source,
      feedClass: chain.feedClass,
      licenseUse: chain.licenseUse,
      fetchedAt: chain.fetchedAt,
      networkAccessed: true,
      guidance:
        "只读策略分析，不创建订单或持仓。期权链的 feedClass/licenseUse 决定可用范围；L0 research_fallback 仅可研究，不能用于交易决策或订单准入。",
    };
  },

  /** 用户级行情上下文；含本机自选和已关联券商的只读持仓。 */
  "market.watchlist.get": async () => {
    const watchlist = await getMarketWatchlist();
    return {
      ...watchlist,
      guidance:
        "兼容工具：自选为用户本机维护；broker_position 仅代表已关联账户返回的持仓。新实现请先用 market.ide_subscription.get 读取 IDE 自选，再按需用 market.broker_quote.get 获取券商行情。",
    };
  },

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
        "先用 market.resolve_symbol 确认市场。研究/回测优先 market.snapshot.get 固定 snapshotId；实时/现价再看 realtimeReadyMarkets 并调用 fetch_quote；原始历史 K 线用 fetch_klines。不要用 readyMarkets（日线能力）冒充实时能力，也不要原样重复调用已 open/down 的源。此结果不代表 call_team_* 调度健康。",
    };
  },

  "market.readiness": async () => getMarketDataReadiness(),

  "market.snapshot.get": async (_ctx, params) => {
    if (!isMarketSnapshotGetEnabled()) {
      throw new Error("market.snapshot.get is disabled (QUBIT_MARKET_SNAPSHOT_GET=0)");
    }
    const contract = isToolContractEnabled() ? getToolContract("market.snapshot.get") : undefined;
    const canonical = contract ? applyToolContract(contract, params) : params;

    const snapshotId = typeof canonical.snapshotId === "string" ? canonical.snapshotId.trim() : "";
    if (snapshotId) {
      return getOrCreateMarketSnapshot({ snapshotId });
    }

    const symbols =
      Array.isArray(canonical.symbols) && canonical.symbols.length > 0
        ? (canonical.symbols as string[]).map(String)
        : extractSymbolArgs(canonical);
    if (symbols.length === 0) {
      requireSymbols(params, { arity: "either", toolName: "market.snapshot.get" });
    }

    const purposeRaw =
      typeof canonical.purpose === "string" ? canonical.purpose.trim().toLowerCase() : "research";
    const purpose =
      purposeRaw === "backtest" ||
      purposeRaw === "observe" ||
      purposeRaw === "trading" ||
      purposeRaw === "risk"
        ? purposeRaw
        : "research";
    const universeHistoryRaw =
      canonical.universeHistory ??
      canonical.universe_history ??
      canonical.universe_history_provenance;
    const corporateActionLedgerRaw =
      canonical.corporateActionLedger ??
      canonical.corporate_action_ledger ??
      canonical.corporate_actions;
    const fundamentalLedgerRaw =
      canonical.fundamentalLedger ??
      canonical.fundamental_ledger ??
      canonical.fundamental_revisions;
    const universeHistory =
      universeHistoryRaw === undefined
        ? undefined
        : MarketUniverseHistorySchema.safeParse(universeHistoryRaw);
    if (universeHistory && !universeHistory.success) {
      throw new Error("market.snapshot.get: universe_history must be a versioned membership table");
    }
    const corporateActionLedger =
      corporateActionLedgerRaw === undefined
        ? undefined
        : MarketCorporateActionLedgerSchema.safeParse(corporateActionLedgerRaw);
    if (corporateActionLedger && !corporateActionLedger.success) {
      throw new Error(
        "market.snapshot.get: corporate_action_ledger must be a versioned point-in-time action ledger"
      );
    }
    const fundamentalLedger =
      fundamentalLedgerRaw === undefined
        ? undefined
        : MarketFundamentalLedgerSchema.safeParse(fundamentalLedgerRaw);
    if (fundamentalLedger && !fundamentalLedger.success) {
      throw new Error(
        "market.snapshot.get: fundamental_ledger must be a versioned point-in-time observation ledger"
      );
    }

    return getOrCreateMarketSnapshot({
      symbols,
      exchange: typeof canonical.exchange === "string" ? canonical.exchange : undefined,
      asOf: typeof canonical.asOf === "string" ? canonical.asOf : undefined,
      purpose,
      timeframe: typeof canonical.timeframe === "string" ? canonical.timeframe : undefined,
      limit: typeof canonical.limit === "number" ? canonical.limit : undefined,
      adjustMethod: typeof canonical.adjustMethod === "string" ? canonical.adjustMethod : undefined,
      timezone: typeof canonical.timezone === "string" ? canonical.timezone : undefined,
      calendarVersion:
        typeof (canonical.calendarVersion ?? canonical.calendar_version) === "string"
          ? String(canonical.calendarVersion ?? canonical.calendar_version)
          : undefined,
      calendarSessionsByVenue:
        canonicalCalendarSessions(
          canonical.calendarSessionsByVenue ?? canonical.calendar_sessions_by_venue
        ) ?? undefined,
      ...(universeHistory?.success ? { universeHistory: universeHistory.data } : {}),
      ...(corporateActionLedger?.success
        ? { corporateActionLedger: corporateActionLedger.data }
        : {}),
      ...(fundamentalLedger?.success ? { fundamentalLedger: fundamentalLedger.data } : {}),
    });
  },

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
    const symbols = extractSymbolArgs(params as Record<string, unknown>);
    const symbol = symbols[0]?.trim() ?? "";
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

function parseOptionStrategyLegs(value: unknown[]): StrategyLegInput[] {
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const action = row.action === "buy" || row.action === "sell" ? row.action : null;
    if (!action) return [];
    const number = (key: string) => {
      const candidate = Number(row[key]);
      return Number.isFinite(candidate) ? candidate : undefined;
    };
    const right = row.right === "call" || row.right === "put" ? row.right : undefined;
    const expiry =
      typeof row.expiry === "string" && row.expiry.trim() ? row.expiry.trim() : undefined;
    const leg: StrategyLegInput = {
      action,
      ...(right ? { right } : {}),
      ...(number("strike") !== undefined ? { strike: number("strike") } : {}),
      ...(number("quantity") !== undefined ? { quantity: number("quantity") } : {}),
      ...(number("entryPrice") !== undefined ? { entryPrice: number("entryPrice") } : {}),
      ...(number("underlyingShares") !== undefined
        ? { underlyingShares: number("underlyingShares") }
        : {}),
      ...(expiry ? { expiry } : {}),
    };
    return [leg];
  });
}
