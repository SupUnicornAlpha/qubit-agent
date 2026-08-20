import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, RefreshCw, Radio, TableProperties } from "lucide-react";
import { getOptionChain, subscribeMarketQuoteStream } from "../../api/backend";
import type {
  MarketOrderBook,
  MarketQuote,
  MarketStreamEvent,
  MarketTrade,
  OptionChain,
  OptionContract,
} from "../../api/types";
import { useAppStore } from "../../store";
import { OptionStrategyBuilder } from "./OptionStrategyBuilder";

type Tab = "market" | "options";
type OptionSourceMode = "auto" | "futu" | "alpaca" | "research";
const money = (value: number | null | undefined, digits = 4) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
const integer = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : value.toLocaleString();

/** K 线下方的专业行情坞：报价订阅、盘口/逐笔快照和研究级期权链。 */
/** 行情页完整深度面板；`optionsOnly` 可嵌入量化工作台的底部停靠栏。 */
export const MarketTerminalDock: FC<{ optionsOnly?: boolean }> = ({ optionsOnly = false }) => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const [tab, setTab] = useState<Tab>(optionsOnly ? "options" : "market");
  const [quote, setQuote] = useState<MarketQuote | null>(null);
  const [orderBook, setOrderBook] = useState<MarketOrderBook | null>(null);
  const [trades, setTrades] = useState<MarketTrade[]>([]);
  const [loadingMarket, setLoadingMarket] = useState(false);
  const [marketReloadNonce, setMarketReloadNonce] = useState(0);
  const [chain, setChain] = useState<OptionChain | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [loadingChain, setLoadingChain] = useState(false);
  const [chainReloadNonce, setChainReloadNonce] = useState(0);
  const [expiry, setExpiry] = useState("");
  const [optionSource, setOptionSource] = useState<OptionSourceMode>("auto");

  const symbol = chartSpec.symbol.trim().toUpperCase();
  const exchange = chartSpec.exchange.trim().toUpperCase();
  const isOptionsEligible = ["US", "OPRA", "HK", "HKEX"].includes(exchange);

  const refreshMarket = useCallback(() => {
    setLoadingMarket(true);
    setMarketReloadNonce((current) => current + 1);
  }, []);
  const refreshChain = useCallback(() => setChainReloadNonce((current) => current + 1), []);

  useEffect(() => {
    setQuote(null);
    setOrderBook(null);
    setTrades([]);
  }, [exchange, symbol]);

  useEffect(() => {
    if (!symbol) return;
    return subscribeMarketQuoteStream({
      subscriptions: [{
        symbol,
        exchange,
        timeframe: chartSpec.timeframe,
        channels: ["quote", "order_book", "trade"],
      }],
      onConnectionChange: (status) => {
        if (status === "connected" || status === "closed") setLoadingMarket(false);
      },
      onEvent: (event) => {
        if (event.kind === "quote" && event.data && typeof event.data === "object") {
          const next = event.data as Partial<MarketQuote>;
          if (!Number.isFinite(next.lastPrice)) return;
          setQuote({
            symbol: event.symbol,
            exchange: event.exchange,
            source: event.source,
            lastPrice: next.lastPrice as number,
            ...(Number.isFinite(next.bidPrice) ? { bidPrice: next.bidPrice } : {}),
            ...(Number.isFinite(next.bidVolume) ? { bidVolume: next.bidVolume } : {}),
            ...(Number.isFinite(next.askPrice) ? { askPrice: next.askPrice } : {}),
            ...(Number.isFinite(next.askVolume) ? { askVolume: next.askVolume } : {}),
            timestamp: typeof next.timestamp === "string" ? next.timestamp : event.emittedAt,
            freshnessMs: Number.isFinite(next.freshnessMs) ? next.freshnessMs as number : 0,
          });
          setLoadingMarket(false);
          return;
        }
        if (event.kind === "order_book") {
          const next = toOrderBook(event);
          if (next) setOrderBook(next);
          return;
        }
        if (event.kind === "trade") {
          const next = toTrade(event);
          if (!next) return;
          setTrades((current) => [next, ...current.filter((trade) => trade.id !== next.id)].slice(0, 12));
        }
      },
    });
  }, [chartSpec.timeframe, exchange, marketReloadNonce, symbol]);

  useEffect(() => {
    if (tab !== "options" || !symbol || !isOptionsEligible) return;
    let cancelled = false;
    setLoadingChain(true);
    setChainError(null);
    void getOptionChain({
      symbol,
      ...(exchange ? { exchange } : {}),
      ...(expiry ? { expiry } : {}),
      source: optionSource,
    })
      .then((next) => {
        if (!cancelled) setChain(next);
      })
      .catch((error: unknown) => {
        if (!cancelled) setChainError(formatOptionChainError(error));
      })
      .finally(() => {
        if (!cancelled) setLoadingChain(false);
      });
    return () => {
      cancelled = true;
    };
  }, [chainReloadNonce, exchange, expiry, isOptionsEligible, optionSource, symbol, tab]);

  useEffect(() => {
    if (tab !== "options" || !symbol || !isOptionsEligible) return;
    const timer = window.setInterval(() => setChainReloadNonce((current) => current + 1), 15_000);
    return () => window.clearInterval(timer);
  }, [isOptionsEligible, symbol, tab]);

  useEffect(() => {
    setExpiry("");
    setChain(null);
    setChainError(null);
  }, [symbol]);

  const spread =
    quote?.askPrice != null && quote.bidPrice != null ? quote.askPrice - quote.bidPrice : null;
  const hasOrderBook = Boolean(orderBook && (orderBook.bids.length > 0 || orderBook.asks.length > 0));
  const hasTrades = trades.length > 0;
  const optionRows = useMemo(() => buildOptionRows(chain, quote?.lastPrice ?? null), [chain, quote?.lastPrice]);

  return (
    <section style={{ ...styles.root, ...(optionsOnly ? styles.optionsOnlyRoot : null) }} aria-label={optionsOnly ? "期权链" : "专业行情面板"}>
      {!optionsOnly ? <header style={styles.header}>
        <div style={styles.tabs} role="tablist" aria-label="行情信息">
          <button type="button" role="tab" aria-selected={tab === "market"} onClick={() => setTab("market")} style={{ ...styles.tab, ...(tab === "market" ? styles.tabActive : null) }}>
            <Radio size={13} /> 行情深度
          </button>
          <button type="button" role="tab" aria-selected={tab === "options"} onClick={() => setTab("options")} style={{ ...styles.tab, ...(tab === "options" ? styles.tabActive : null) }}>
            <TableProperties size={13} /> 期权链
          </button>
        </div>
        <div style={styles.headerMeta}>
          <span>{symbol || "—"} · {exchange || "AUTO"}</span>
          <button type="button" className="qb-btn-secondary qb-btn--compact" onClick={refreshMarket} disabled={loadingMarket} title="重新订阅行情深度与逐笔成交">
            <RefreshCw size={13} aria-hidden />
          </button>
        </div>
      </header> : null}

      {tab === "market" ? (
        <div style={styles.marketBody}>
          <div style={styles.quoteStrip}>
            <Metric label="最新" value={money(quote?.lastPrice)} accent />
            <Metric label="买一" value={money(quote?.bidPrice)} detail={integer(quote?.bidVolume)} />
            <Metric label="卖一" value={money(quote?.askPrice)} detail={integer(quote?.askVolume)} />
            <Metric label="价差" value={money(spread, 6)} />
            <Metric label="新鲜度" value={quote ? `${Math.max(0, Math.round(quote.freshnessMs / 1000))}s` : "—"} />
            <Metric label="来源" value={quote?.source ?? "等待订阅"} compact />
          </div>
          {hasOrderBook || hasTrades ? <div style={styles.depthGrid}>
            {hasOrderBook ? <DepthTable title="五档买盘" rows={orderBook?.bids ?? []} side="bid" /> : null}
            {hasOrderBook ? <DepthTable title="五档卖盘" rows={orderBook?.asks ?? []} side="ask" /> : null}
            {hasTrades ? <TradeTape trades={trades} /> : null}
          </div> : null}
        </div>
      ) : (
        <div style={styles.optionsBody}>
          {!isOptionsEligible ? (
            <div style={styles.empty}><BookOpen size={16} /> 券商期权链支持富途可授权的美股、港股标的；公开研究降级仅覆盖美股。请切换为对应市场并输入如 AAPL、NVDA、00700 的标的代码。</div>
          ) : (
            <>
              <div style={styles.optionControls}>
                <span>{optionChainSourceLabel(chain, optionSource)}{loadingChain && chain ? " · 正在刷新…" : ""}</span>
                <div style={styles.optionSelectors}>
                  <select value={optionSource} onChange={(event) => setOptionSource(event.target.value as OptionSourceMode)} style={styles.select} aria-label="选择期权链行情源">
                    <option value="auto">自动：券商优先</option>
                    <option value="futu">富途 OpenD（严格）</option>
                    <option value="alpaca">Alpaca（严格）</option>
                    <option value="research">Yahoo / yfinance（研究）</option>
                  </select>
                  <select value={expiry} onChange={(event) => setExpiry(event.target.value)} style={styles.select} aria-label="选择期权到期日">
                    <option value="">最近到期</option>
                    {(chain?.expirations ?? []).map((date) => <option key={date} value={date}>{date.slice(0, 10)}</option>)}
                  </select>
                  <button type="button" className="qb-btn-secondary qb-btn--compact" onClick={refreshChain} disabled={loadingChain} title="刷新期权链并重算策略">
                    <RefreshCw size={13} aria-hidden />
                  </button>
                </div>
              </div>
              {chain?.fallbackUsed ? <div style={styles.notice}>已降级为研究级期权链：{chain.fallbackReason ?? "券商行情暂不可用"}</div> : null}
              {loadingChain && !chain ? <div style={styles.empty}>正在加载期权链…</div> : null}
              {chainError ? <div style={styles.notice}>期权链加载失败：{chainError}</div> : null}
              {chain ? <>
                <OptionStrategyBuilder chain={chain} spot={quote?.lastPrice ?? null} exchange={exchange} expiry={expiry} source={optionSource} />
                <OptionTable rows={optionRows} />
              </> : null}
            </>
          )}
        </div>
      )}
    </section>
  );
};

const Metric: FC<{ label: string; value: string; detail?: string; accent?: boolean; compact?: boolean }> = ({ label, value, detail, accent, compact }) => (
  <div style={styles.metric}>
    <span style={styles.metricLabel}>{label}</span>
    <strong style={{ ...styles.metricValue, ...(accent ? styles.metricAccent : null), ...(compact ? styles.metricCompact : null) }}>{value}</strong>
    {detail ? <span style={styles.metricDetail}>{detail}</span> : null}
  </div>
);

const DepthTable: FC<{ title: string; rows: Array<{ price: number; volume: number }>; side: "bid" | "ask" }> = ({ title, rows, side }) => (
  <div style={styles.depthPanel}>
    <div style={styles.panelTitle}>{title}</div>
    {rows.slice(0, 5).map((row, index) => <div key={`${row.price}-${index}`} style={styles.depthRow}><span>{index + 1}</span><strong style={{ color: side === "bid" ? "var(--qb-success, #34d399)" : "var(--qb-danger, #fb7185)" }}>{money(row.price)}</strong><span>{integer(row.volume)}</span></div>)}
    {rows.length === 0 ? <div style={styles.panelEmpty}>暂无盘口</div> : null}
  </div>
);

const TradeTape: FC<{ trades: MarketTrade[] }> = ({ trades }) => (
  <div style={styles.depthPanel}>
    <div style={styles.panelTitle}>逐笔成交</div>
    {trades.slice(0, 5).map((trade) => <div key={trade.id} style={styles.depthRow}><span>{trade.timestamp.slice(11, 19)}</span><strong style={{ color: trade.side === "buy" ? "var(--qb-success, #34d399)" : trade.side === "sell" ? "var(--qb-danger, #fb7185)" : "inherit" }}>{money(trade.price)}</strong><span>{integer(trade.volume)}</span></div>)}
    {trades.length === 0 ? <div style={styles.panelEmpty}>暂无逐笔</div> : null}
  </div>
);

function toFinite(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toOrderBook(event: MarketStreamEvent): MarketOrderBook | null {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const data = event.data as Record<string, unknown>;
  const levels = (value: unknown) => Array.isArray(value)
    ? value.flatMap((item) => {
      const row = Array.isArray(item)
        ? { price: item[0], volume: item[1], orderCount: item[2] }
        : item && typeof item === "object" ? item as Record<string, unknown> : null;
      const price = toFinite(row?.price);
      const volume = toFinite(row?.volume);
      return price != null && volume != null && price > 0 && volume >= 0
        ? [{ price, volume, ...(toFinite(row?.orderCount) != null ? { orderCount: toFinite(row?.orderCount) as number } : {}) }]
        : [];
    })
    : [];
  const bids = levels(data.bids ?? data.Bid);
  const asks = levels(data.asks ?? data.Ask);
  if (bids.length === 0 && asks.length === 0) return null;
  return {
    symbol: event.symbol,
    exchange: event.exchange,
    source: event.source,
    bids,
    asks,
    timestamp: typeof data.timestamp === "string" ? data.timestamp : event.emittedAt,
    freshnessMs: toFinite(data.freshnessMs) ?? 0,
  };
}

function toTrade(event: MarketStreamEvent): MarketTrade | null {
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return null;
  const data = event.data as Record<string, unknown>;
  const price = toFinite(data.price);
  const volume = toFinite(data.volume);
  if (price == null || price <= 0 || volume == null || volume < 0) return null;
  const direction = String(data.side ?? data.tickerDirection ?? data.ticker_direction ?? "").toLowerCase();
  const side: MarketTrade["side"] = direction.includes("buy") || direction.includes("up")
    ? "buy"
    : direction.includes("sell") || direction.includes("down")
      ? "sell"
      : direction.includes("neutral") ? "neutral" : "unknown";
  const timestamp = typeof data.timestamp === "string" ? data.timestamp : event.emittedAt;
  return {
    id: String(data.id ?? data.sequence ?? `${event.symbol}:${timestamp}:${price}:${volume}`),
    symbol: event.symbol,
    exchange: event.exchange,
    source: event.source,
    price,
    volume,
    side,
    timestamp,
  };
}

function buildOptionRows(chain: OptionChain | null, spot: number | null) {
  if (!chain) return [];
  const calls = new Map(chain.calls.map((contract) => [contract.strike, contract]));
  const puts = new Map(chain.puts.map((contract) => [contract.strike, contract]));
  return [...new Set([...calls.keys(), ...puts.keys()])]
    .sort((left, right) => (spot == null ? left - right : Math.abs(left - spot) - Math.abs(right - spot)))
    .slice(0, 12)
    .sort((left, right) => left - right)
    .map((strike) => ({ strike, call: calls.get(strike), put: puts.get(strike) }));
}

function formatOptionChainError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/invalid crumb|unauthorized/i.test(raw)) {
    return "Yahoo 会话已失效；已尝试 yfinance 会话与公开兜底源，暂时未能取得期权链。请稍后刷新或检查网络代理。";
  }
  return raw.length > 360 ? `${raw.slice(0, 357)}…` : raw;
}

function optionChainSourceLabel(chain: OptionChain | null, mode: OptionSourceMode): string {
  if (!chain) {
    return mode === "futu"
      ? "富途 OpenD 券商期权链 · 仅券商数据"
      : mode === "alpaca"
        ? "Alpaca 券商期权链 · 仅券商数据"
      : mode === "research"
        ? "Yahoo / yfinance 研究级期权链 · 不用于实盘报价"
        : "券商优先期权链 · OpenD 不可用时明确降级为研究数据";
  }
  if (chain.source === "futu_opend") {
    return "富途 OpenD 券商快照 · 最新价 / 买卖价 / IV / OI / Greeks · 观察级行情";
  }
  if (chain.source === "alpaca") {
    return "Alpaca 券商快照 · 最新价 / 买卖价 / Greeks · 观察级行情";
  }
  return `${chain.source === "yfinance" ? "yfinance 会话" : "Yahoo 公共数据"} · 研究级，不用于实盘报价或交易准入`;
}

const OptionTable: FC<{ rows: Array<{ strike: number; call?: OptionContract; put?: OptionContract }> }> = ({ rows }) => (
  <div style={styles.optionTableWrap}>
    <table style={styles.optionTable}>
      <thead>
        <tr>
          <th style={styles.optionHead} colSpan={5}>CALL</th>
          <th style={styles.optionHead}>行权价</th>
          <th style={styles.optionHead} colSpan={5}>PUT</th>
        </tr>
        <tr>{["最新", "买 / 卖", "IV", "OI", "Δ", "Strike", "最新", "买 / 卖", "IV", "OI", "Δ"].map((label, index) => <th key={`${label}-${index}`} style={styles.optionHead}>{label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map(({ strike, call, put }) => (
          <tr key={strike}>
            <td style={styles.optionCell}>{money(call?.lastPrice)}</td><td style={styles.optionCell}>{money(call?.bid)} / {money(call?.ask)}</td><td style={styles.optionCell}>{call?.impliedVolatility == null ? "—" : `${(call.impliedVolatility * 100).toFixed(1)}%`}</td><td style={styles.optionCell}>{integer(call?.openInterest)}</td><td style={styles.optionCell}>{money(call?.greeks?.delta, 3)}</td>
            <td style={{ ...styles.optionCell, ...styles.strike }}>{money(strike)}</td>
            <td style={styles.optionCell}>{money(put?.lastPrice)}</td><td style={styles.optionCell}>{money(put?.bid)} / {money(put?.ask)}</td><td style={styles.optionCell}>{put?.impliedVolatility == null ? "—" : `${(put.impliedVolatility * 100).toFixed(1)}%`}</td><td style={styles.optionCell}>{integer(put?.openInterest)}</td><td style={styles.optionCell}>{money(put?.greeks?.delta, 3)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

const styles: Record<string, CSSProperties> = {
  root: { flex: "0 0 244px", minHeight: 206, display: "flex", flexDirection: "column", borderTop: "1px solid var(--qb-kline-header-border, #27272a)", background: "var(--qb-main-panel-bg, #101014)", color: "var(--qb-body-fg, #e4e4e7)", overflow: "hidden" },
  optionsOnlyRoot: { flex: "1 1 auto", minHeight: 0, borderTop: 0 },
  header: { flexShrink: 0, minHeight: 38, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "0 12px", borderBottom: "1px solid var(--qb-kline-header-border, #27272a)" },
  tabs: { display: "flex", alignSelf: "stretch" },
  tab: { display: "inline-flex", alignItems: "center", gap: 5, border: 0, borderBottom: "2px solid transparent", padding: "0 10px", background: "transparent", color: "var(--qb-main-meta, #a1a1aa)", cursor: "pointer", fontSize: 12 },
  tabActive: { color: "var(--qb-info, #60a5fa)", borderBottomColor: "var(--qb-info, #60a5fa)" },
  headerMeta: { display: "flex", alignItems: "center", gap: 8, color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, fontFamily: "var(--qb-font-mono, ui-monospace, monospace)" },
  marketBody: { minHeight: 0, flex: 1, overflow: "auto" },
  quoteStrip: { display: "grid", gridTemplateColumns: "repeat(6, minmax(82px, 1fr))", borderBottom: "1px solid var(--qb-kline-header-border, #27272a)" },
  metric: { minWidth: 0, padding: "8px 10px", borderRight: "1px solid var(--qb-kline-header-border, #27272a)", display: "grid", gap: 2 },
  metricLabel: { color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10 },
  metricValue: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontVariantNumeric: "tabular-nums" },
  metricAccent: { color: "var(--qb-success, #34d399)", fontSize: 16 },
  metricCompact: { fontSize: 11 },
  metricDetail: { color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10 },
  notice: { padding: "6px 10px", color: "var(--qb-warn, #f59e0b)", fontSize: 11 },
  depthGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(145px, 1fr))", gap: 8, padding: 8 },
  depthPanel: { minWidth: 0, border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 6, overflow: "hidden" },
  panelTitle: { padding: "5px 7px", borderBottom: "1px solid var(--qb-main-card-border, #27272a)", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, fontWeight: 700 },
  depthRow: { display: "grid", gridTemplateColumns: "28px minmax(0, 1fr) minmax(0, 1fr)", gap: 6, padding: "3px 7px", fontFamily: "var(--qb-font-mono, ui-monospace, monospace)", fontSize: 10, fontVariantNumeric: "tabular-nums" },
  panelEmpty: { padding: "18px 8px", color: "var(--qb-main-meta, #a1a1aa)", textAlign: "center", fontSize: 11 },
  optionsBody: { minHeight: 0, flex: 1, overflow: "auto" },
  optionControls: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, padding: "7px 10px", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10 },
  optionSelectors: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
  select: { maxWidth: 150, minWidth: 110, padding: "4px 7px", borderRadius: 5, border: "1px solid var(--qb-main-input-border, #3f3f46)", background: "var(--qb-main-input-bg, #18181b)", color: "var(--qb-main-input-fg, #e4e4e7)", fontSize: 11 },
  empty: { minHeight: 110, display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: 14, color: "var(--qb-main-meta, #a1a1aa)", fontSize: 12, textAlign: "center" },
  optionTableWrap: { overflow: "auto", borderTop: "1px solid var(--qb-kline-header-border, #27272a)" },
  optionTable: { width: "100%", minWidth: 900, borderCollapse: "collapse", fontSize: 11, fontVariantNumeric: "tabular-nums" },
  optionHead: { padding: "5px 7px", borderBottom: "1px solid var(--qb-kline-header-border, #27272a)", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" },
  optionCell: { padding: "5px 7px", borderBottom: "1px solid color-mix(in srgb, var(--qb-kline-header-border, #27272a) 65%, transparent)", textAlign: "right", whiteSpace: "nowrap" },
  strike: { color: "var(--qb-info, #60a5fa)", fontWeight: 700 },
};
