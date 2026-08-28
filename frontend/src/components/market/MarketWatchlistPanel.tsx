import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Minus, Plus, RefreshCw, WalletCards } from "lucide-react";
import {
  addMarketWatchlistItem,
  getKlinesBatch,
  getMarketWatchlist,
  removeMarketWatchlistItem,
  subscribeMarketQuoteStream,
} from "../../api/backend";
import type { KlineBar, MarketQuote, MarketWatchlistEntry, MarketWatchlistSnapshot } from "../../api/types";
import { useAppStore } from "../../store";

type QuoteState = Record<string, MarketQuote | undefined>;
type StreamStatus = "connecting" | "connected" | "reconnecting" | "stale" | "closed";
type MarketPanelTab = "watchlist" | "positions";
type SparklineData = { bars: KlineBar[]; intradayChange: number | null };
type SparklineState = Record<string, SparklineData | undefined>;
const SPARKLINE_TIMEFRAME = "5m";
/** 小 K 线只需最近 16 根；limit 24 留余量 */
const SPARKLINE_LIMIT = 24;
const SPARKLINE_DEFER_MS = 600;
const quoteKey = (entry: Pick<MarketWatchlistEntry, "symbol" | "exchange">) =>
  `${entry.symbol}:${entry.exchange}`;
const positionKey = (entry: MarketWatchlistEntry) =>
  `${quoteKey(entry)}:${entry.position?.provider ?? "unknown"}:${entry.position?.accountRef ?? "unknown"}`;

function intradaySparkline(bars: KlineBar[]): SparklineData {
  if (!bars.length) return { bars: [], intradayChange: null };
  const latestSession = bars[bars.length - 1]?.timestamp.slice(0, 10);
  const sessionBars = latestSession
    ? bars.filter((bar) => bar.timestamp.slice(0, 10) === latestSession)
    : bars;
  const first = sessionBars[0]?.open;
  const last = sessionBars[sessionBars.length - 1]?.close;
  const visibleBars = sessionBars.slice(-16);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) {
    return { bars: visibleBars, intradayChange: null };
  }
  return { bars: visibleBars, intradayChange: ((last - first) / first) * 100 };
}

const numberLabel = (value: number, digits = 2) =>
  value.toLocaleString(undefined, { maximumFractionDigits: digits });

function MiniCandles({ bars, symbol }: { bars: KlineBar[] | undefined; symbol: string }) {
  if (!bars?.length) return <div style={styles.miniChartEmpty} title="暂无 K 线数据">—</div>;
  const highs = bars.map((bar) => bar.high);
  const lows = bars.map((bar) => bar.low);
  const top = Math.max(...highs);
  const bottom = Math.min(...lows);
  const range = top - bottom || Math.max(Math.abs(top) * 0.01, 1);
  const height = 36;
  const pad = 3;
  const y = (price: number) => pad + ((top - price) / range) * (height - pad * 2);
  const width = 78;
  const step = width / bars.length;
  const bodyWidth = Math.max(1.5, Math.min(4, step * 0.58));
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${symbol} 最近 ${bars.length} 根 K 线`} style={styles.miniChart}>
      {bars.map((bar, index) => {
        const color = bar.close >= bar.open ? "var(--qb-success, #34d399)" : "var(--qb-danger, #fb7185)";
        const x = (index + 0.5) * step;
        const openY = y(bar.open);
        const closeY = y(bar.close);
        return <g key={`${bar.timestamp}:${index}`} stroke={color} fill={color}>
          <line x1={x} x2={x} y1={y(bar.high)} y2={y(bar.low)} strokeWidth="1" />
          <rect x={x - bodyWidth / 2} y={Math.min(openY, closeY)} width={bodyWidth} height={Math.max(1.3, Math.abs(closeY - openY))} rx="0.6" />
        </g>;
      })}
    </svg>
  );
}

type MarketFilter = { id: string; label: string; count: number };

function marketFilterFor(entry: Pick<MarketWatchlistEntry, "exchange">): Omit<MarketFilter, "count"> {
  const exchange = entry.exchange.trim().toUpperCase();
  if (["OPRA", "OCC"].includes(exchange)) return { id: "options-us", label: "美股期权" };
  if (["US", "NASDAQ", "NYSE", "AMEX", "ARCA"].includes(exchange)) return { id: "us", label: "美股" };
  if (["SH", "SSE", "XSHG", "CN-SH"].includes(exchange)) return { id: "cn-sh", label: "沪市" };
  if (["SZ", "SZSE", "XSHE", "CN-SZ"].includes(exchange)) return { id: "cn-sz", label: "深市" };
  if (["HK", "HKEX"].includes(exchange)) return { id: "hk", label: "港股" };
  if (["CRYPTO", "BINANCE", "CC"].includes(exchange)) return { id: "crypto", label: "加密资产" };
  if (!exchange || exchange === "AUTO") return { id: "auto", label: "未指定市场" };
  return { id: `exchange:${exchange}`, label: exchange };
}

/**
 * 可嵌入行情页或 IDE 工作台的同一份用户行情上下文。
 * 自选和券商持仓分开呈现：手动自选可删除，持仓只读，避免“删掉持仓”等误导性操作。
 */
export const MarketWatchlistPanel: FC<{ compact?: boolean }> = ({ compact = false }) => {
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const requestChartReload = useAppStore((s) => s.requestChartReload);
  const [snapshot, setSnapshot] = useState<MarketWatchlistSnapshot | null>(null);
  const [quotes, setQuotes] = useState<QuoteState>({});
  const [symbol, setSymbol] = useState("");
  const [exchange, setExchange] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [streamSource, setStreamSource] = useState<string | null>(null);
  const [streamTransport, setStreamTransport] = useState<"push" | "polling">("push");
  const [lastQuoteAt, setLastQuoteAt] = useState<string | null>(null);
  const [marketFilter, setMarketFilter] = useState("all");
  const [activeTab, setActiveTab] = useState<MarketPanelTab>("watchlist");
  const [pendingRemoval, setPendingRemoval] = useState<MarketWatchlistEntry | null>(null);
  const [sparklines, setSparklines] = useState<SparklineState>({});
  const [sparklineRefresh, setSparklineRefresh] = useState(0);

  const load = useCallback(async (opts?: { includePositions?: boolean }) => {
    const includePositions = opts?.includePositions ?? false;
    setBusy(true);
    try {
      const next = await getMarketWatchlist({ includePositions });
      setSnapshot((previous) => {
        if (!includePositions && previous?.positionEntries.length) {
          return {
            ...next,
            positionEntries: previous.positionEntries,
            connectedAccounts: previous.connectedAccounts,
            brokerErrors: previous.brokerErrors,
            entries: [
              ...next.watchlistEntries,
              ...previous.positionEntries.filter(
                (entry) =>
                  !next.watchlistEntries.some(
                    (manual) =>
                      manual.symbol === entry.symbol && manual.exchange === entry.exchange
                  )
              ),
            ],
          };
        }
        return next;
      });
      setQuotes((previous) => {
        const allowed = new Set([
          ...(next.watchlistEntries ?? next.entries.filter((entry) => entry.sources.includes("manual"))),
          ...(includePositions
            ? (next.positionEntries ?? next.entries.filter((entry) => entry.position))
            : []),
        ].map(quoteKey));
        return Object.fromEntries(Object.entries(previous).filter(([key]) => allowed.has(key)));
      });
      if (includePositions) setSparklineRefresh((value) => value + 1);
      setMessage(null);
    } catch (error) {
      setMessage(`加载行情上下文失败：${error instanceof Error ? error.message : "unknown_error"}`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load({ includePositions: false });
  }, [load]);

  useEffect(() => {
    if (activeTab !== "positions") return;
    void load({ includePositions: true });
  }, [activeTab, load]);

  const watchlistEntries = snapshot?.watchlistEntries ?? snapshot?.entries.filter((entry) => entry.sources.includes("manual")) ?? [];
  const positionEntries = snapshot?.positionEntries ?? snapshot?.entries.filter((entry) => entry.position) ?? [];
  const entries = activeTab === "watchlist" ? watchlistEntries : positionEntries;
  const marketFilters = useMemo<MarketFilter[]>(() => {
    const grouped = new Map<string, MarketFilter>();
    for (const entry of entries) {
      const market = marketFilterFor(entry);
      const current = grouped.get(market.id);
      grouped.set(market.id, { ...market, count: (current?.count ?? 0) + 1 });
    }
    return [...grouped.values()].sort((left, right) => left.label.localeCompare(right.label, "zh-CN"));
  }, [entries]);
  const visibleEntries = useMemo(
    () => marketFilter === "all" ? entries : entries.filter((entry) => marketFilterFor(entry).id === marketFilter),
    [entries, marketFilter],
  );

  useEffect(() => {
    if (marketFilter !== "all" && !marketFilters.some((market) => market.id === marketFilter)) {
      setMarketFilter("all");
    }
  }, [marketFilter, marketFilters]);

  const sparklineEntriesKey = useMemo(
    () => [...new Map([...watchlistEntries, ...positionEntries].map((entry) => [quoteKey(entry), entry])).keys()].sort().join("|"),
    [watchlistEntries, positionEntries],
  );

  useEffect(() => {
    const uniqueEntries = [...new Map([...watchlistEntries, ...positionEntries].map((entry) => [quoteKey(entry), entry])).values()];
    if (!uniqueEntries.length) {
      setSparklines({});
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getKlinesBatch({
        requests: uniqueEntries.slice(0, 30).map((entry) => ({
          symbol: entry.symbol,
          exchange: entry.exchange,
          timeframe: SPARKLINE_TIMEFRAME,
          limit: SPARKLINE_LIMIT,
        })),
      }).then((batch) => {
        if (cancelled) return;
        setSparklines((previous) => {
          const next: SparklineState = { ...previous };
          for (const entry of uniqueEntries.slice(0, 30)) {
            const key = quoteKey(entry);
            const row = batch[`${entry.symbol.toUpperCase()}:${entry.exchange.toUpperCase()}`];
            if (row?.bars?.length) next[key] = intradaySparkline(row.bars);
          }
          return next;
        });
      });
    }, SPARKLINE_DEFER_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sparklineEntriesKey, sparklineRefresh, watchlistEntries, positionEntries]);

  const subscriptionKey = visibleEntries
    .slice(0, 30)
    .map(quoteKey)
    .join("|");

  useEffect(() => {
    const subscribedEntries = visibleEntries.slice(0, 30);
    if (subscribedEntries.length === 0) {
      setStreamStatus("closed");
      setStreamSource(null);
      setStreamTransport("push");
      return;
    }
    return subscribeMarketQuoteStream({
      subscriptions: subscribedEntries.map((entry) => ({ symbol: entry.symbol, exchange: entry.exchange })),
      onConnectionChange: setStreamStatus,
      onEvent: (event) => {
        if (event.kind !== "quote" || !event.data || typeof event.data !== "object") return;
        const candidate = event.data as Partial<MarketQuote> & { streamTransport?: unknown };
        if (!Number.isFinite(candidate.lastPrice)) return;
        const key = `${event.symbol}:${event.exchange}`;
        setQuotes((previous) => ({
          ...previous,
          [key]: {
            symbol: event.symbol,
            exchange: event.exchange,
            source: event.source,
            lastPrice: candidate.lastPrice as number,
            ...(Number.isFinite(candidate.bidPrice) ? { bidPrice: candidate.bidPrice } : {}),
            ...(Number.isFinite(candidate.bidVolume) ? { bidVolume: candidate.bidVolume } : {}),
            ...(Number.isFinite(candidate.askPrice) ? { askPrice: candidate.askPrice } : {}),
            ...(Number.isFinite(candidate.askVolume) ? { askVolume: candidate.askVolume } : {}),
            timestamp: typeof candidate.timestamp === "string" ? candidate.timestamp : event.emittedAt,
            freshnessMs: Number.isFinite(candidate.freshnessMs) ? candidate.freshnessMs as number : 0,
          },
        }));
        setStreamSource(event.source);
        setStreamTransport(candidate.streamTransport === "polling" ? "polling" : "push");
        setLastQuoteAt(event.emittedAt);
      },
    });
  }, [subscriptionKey, visibleEntries]);

  const add = async () => {
    if (!symbol.trim()) return;
    setBusy(true);
    try {
      const next = await addMarketWatchlistItem({ symbol, ...(exchange.trim() ? { exchange } : {}) });
      setSnapshot((previous) => ({
        ...next,
        ...(previous?.positionEntries.length
          ? {
              positionEntries: previous.positionEntries,
              connectedAccounts: previous.connectedAccounts,
              brokerErrors: previous.brokerErrors,
            }
          : null),
      }));
      setSparklineRefresh((value) => value + 1);
      setSymbol("");
      setExchange("");
    } catch (error) {
      setMessage(`添加失败：${error instanceof Error ? error.message : "invalid_symbol"}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!pendingRemoval) return;
    const entry = pendingRemoval;
    setBusy(true);
    try {
      const next = await removeMarketWatchlistItem(entry.symbol, entry.exchange || undefined);
      setSnapshot(next);
      setPendingRemoval(null);
      setSparklineRefresh((value) => value + 1);
      setQuotes((previous) => {
        const updated = { ...previous };
        delete updated[quoteKey(entry)];
        return updated;
      });
    } catch (error) {
      setMessage(`移除失败：${error instanceof Error ? error.message : "unknown_error"}`);
    } finally {
      setBusy(false);
    }
  };

  const open = (entry: MarketWatchlistEntry) => {
    setChartSpec({ symbol: entry.symbol, exchange: entry.exchange });
    requestChartReload();
  };

  return (
    <section style={{ ...styles.root, ...(compact ? styles.compactRoot : null) }} aria-label="行情自选与持仓">
      <header style={styles.header}>
        <div>
          <div style={styles.kicker}>MARKET CONTEXT</div>
          <h2 style={styles.title}>{activeTab === "watchlist" ? "自选" : "持仓"}</h2>
        </div>
        <div style={styles.headerActions}>
          <span
            style={{
              ...styles.streamState,
              ...(streamStatus === "connected"
                ? styles.streamStateOk
                : streamStatus === "reconnecting" || streamStatus === "stale"
                  ? styles.streamStateWarn
                  : null),
            }}
            title={streamSource ? `报价来源：${streamSource}` : "等待行情订阅"}
          >
            <i style={styles.streamDot} aria-hidden />
            {streamStatus === "connected"
              ? streamTransport === "polling"
                ? "2 秒刷新"
                : "实时订阅"
              : streamStatus === "reconnecting"
                ? "重连中"
                : streamStatus === "stale"
                  ? "数据延迟"
                  : streamStatus === "closed"
                    ? "未订阅"
                    : "连接中"}
          </span>
          <button type="button" className="qb-btn-secondary qb-btn--compact" onClick={() => void load({ includePositions: activeTab === "positions" })} disabled={busy} title="刷新自选、K 线和券商持仓">
            <RefreshCw size={14} aria-hidden /> 刷新
          </button>
        </div>
      </header>

      <div style={styles.primaryTabs} role="tablist" aria-label="自选与持仓页面">
        <button type="button" role="tab" aria-selected={activeTab === "watchlist"} onClick={() => { setActiveTab("watchlist"); setMarketFilter("all"); }} style={{ ...styles.primaryTab, ...(activeTab === "watchlist" ? styles.primaryTabActive : null) }}>
          自选 <span>{watchlistEntries.length}</span>
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "positions"} onClick={() => { setActiveTab("positions"); setMarketFilter("all"); }} style={{ ...styles.primaryTab, ...(activeTab === "positions" ? styles.primaryTabActive : null) }}>
          <WalletCards size={13} aria-hidden /> 持仓 <span>{positionEntries.length}</span>
        </button>
      </div>
      <p style={styles.summary}>
        {activeTab === "watchlist"
          ? "本机自选可供行情查看与 Agent 研究。"
          : snapshot?.connectedAccounts
            ? `已关联 ${snapshot.connectedAccounts} 个券商账户；此页每次刷新均从券商读取。`
            : "尚未关联券商账户。配置并启用券商后，持仓会自动显示在这里。"}
      </p>
      {activeTab === "watchlist" ? <div style={styles.addRow}>
        <input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void add(); } }} placeholder="代码，如 AAPL / 600519" aria-label="添加自选代码" style={styles.symbolInput} />
        <input value={exchange} onChange={(event) => setExchange(event.target.value.toUpperCase())} placeholder="市场（可选）" aria-label="市场代码" style={styles.exchangeInput} />
        <button type="button" className="qb-btn-primary-brand" onClick={() => void add()} disabled={busy || !symbol.trim()} style={styles.addButton} title="添加到自选">
          <Plus size={15} aria-hidden />
        </button>
      </div> : null}

      <div style={styles.marketFilterBar} role="tablist" aria-label={`按市场筛选${activeTab === "watchlist" ? "自选" : "持仓"}`}>
        <button type="button" role="tab" aria-selected={marketFilter === "all"} onClick={() => setMarketFilter("all")} style={{ ...styles.marketFilter, ...(marketFilter === "all" ? styles.marketFilterActive : null) }}>
          全部 <span>{entries.length}</span>
        </button>
        {marketFilters.map((market) => (
          <button key={market.id} type="button" role="tab" aria-selected={marketFilter === market.id} onClick={() => setMarketFilter(market.id)} style={{ ...styles.marketFilter, ...(marketFilter === market.id ? styles.marketFilterActive : null) }}>
            {market.label} <span>{market.count}</span>
          </button>
        ))}
      </div>
      <div style={styles.filterSummary}>当前显示 {visibleEntries.length} / {entries.length} 个标的；小 K 线显示当日最近 16 根 5 分钟 K 线与日内涨跌。</div>
      {lastQuoteAt ? <div style={styles.streamMeta}>已订阅前 {Math.min(visibleEntries.length, 30)} 个标的 · 最近更新 {new Date(lastQuoteAt).toLocaleTimeString()}</div> : null}
      {message ? <div role="status" style={styles.notice}>{message}</div> : null}
      {activeTab === "positions" && snapshot?.brokerErrors.length ? <div style={styles.warning}>部分券商持仓暂不可读：{snapshot.brokerErrors[0]}</div> : null}
      <div style={styles.list}>
        {visibleEntries.map((entry) => {
          const quote = quotes[quoteKey(entry)];
          const sparkline = sparklines[quoteKey(entry)];
          const change = sparkline?.intradayChange ?? null;
          const isPending = pendingRemoval && quoteKey(pendingRemoval) === quoteKey(entry);
          return (
            <article key={activeTab === "positions" ? positionKey(entry) : quoteKey(entry)} style={styles.item}>
              <button type="button" onClick={() => open(entry)} style={styles.itemOpen} title={`查看 ${entry.symbol} 行情`}>
                <div style={styles.itemTop}>
                  <strong style={styles.symbol}>{entry.symbol}</strong>
                  <span style={styles.exchange}>{entry.exchange || "AUTO"}</span>
                  {activeTab === "positions" ? <span style={styles.positionBadge}><WalletCards size={11} />持仓</span> : null}
                </div>
                <div style={styles.priceLine}>
                  <span style={styles.price}>{quote ? numberLabel(quote.lastPrice, 4) : "—"}</span>
                  <span style={styles.quoteMeta}>{quote ? quote.source : "等待报价"}</span>
                </div>
                {entry.position ? <div style={styles.positionMeta}>仓位 {numberLabel(entry.position.quantity, 4)} · 成本 {numberLabel(entry.position.averagePrice, 4)} · {entry.position.provider}</div> : null}
              </button>
              <div style={styles.itemChart}>
                <MiniCandles bars={sparkline?.bars} symbol={entry.symbol} />
                <span style={{ ...styles.change, ...(change === null ? null : change >= 0 ? styles.changePositive : styles.changeNegative) }}>
                  {change === null ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                </span>
              </div>
              {activeTab === "watchlist" ? isPending ? (
                <div style={styles.removeConfirm} role="group" aria-label={`确认删除 ${entry.symbol}`}>
                  <span>删除 {entry.symbol}？</span>
                  <button type="button" onClick={() => void remove()} disabled={busy} style={styles.confirmDelete}>删除</button>
                  <button type="button" onClick={() => setPendingRemoval(null)} disabled={busy} style={styles.confirmCancel}>取消</button>
                </div>
              ) : <button type="button" className="qb-btn-secondary qb-btn--compact" onClick={() => setPendingRemoval(entry)} disabled={busy} aria-label={`移除 ${entry.symbol}`} title="移除自选"><Minus size={13} aria-hidden /></button> : null}
            </article>
          );
        })}
        {!busy && entries.length === 0 ? <div style={styles.empty}>{activeTab === "watchlist" ? "还没有自选。添加代码后，它会成为你和 Agent 共用的行情上下文。" : snapshot?.connectedAccounts ? "券商暂未返回非零持仓；点击刷新可再次读取。" : "配置券商并启用账户后，持仓将自动从券商读取。"}</div> : null}
        {!busy && entries.length > 0 && visibleEntries.length === 0 ? <div style={styles.empty}>当前市场没有{activeTab === "watchlist" ? "自选" : "持仓"}标的。切换到“全部”或选择其他市场。</div> : null}
      </div>
      <footer style={styles.footer}>{activeTab === "watchlist" ? <>自选由本机维护：Agent 可用 <code>market.ide_subscription.get</code> 读取。</> : <>持仓为只读券商数据：刷新时通过已配置的券商账户重新读取，不会写回券商。</>}</footer>
    </section>
  );
};

const inputStyle: CSSProperties = { background: "var(--qb-main-input-bg, #18181b)", border: "1px solid var(--qb-main-input-border, #3f3f46)", borderRadius: 6, color: "var(--qb-main-input-fg, #e4e4e7)", padding: "7px 8px", fontSize: 11 };

const styles: Record<string, CSSProperties> = {
  root: { height: "100%", minHeight: 0, display: "flex", flexDirection: "column", padding: 16, color: "var(--qb-body-fg)", background: "var(--qb-main-panel-bg, #101014)" },
  compactRoot: { padding: 12 },
  header: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 },
  headerActions: { display: "flex", alignItems: "center", gap: 7, flexShrink: 0 },
  kicker: { fontSize: 10, letterSpacing: "0.12em", color: "var(--qb-main-meta)", fontWeight: 700 },
  title: { margin: "3px 0 0", fontSize: 17, lineHeight: 1.2 },
  primaryTabs: { display: "flex", gap: 4, padding: 3, marginTop: 11, border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 7, background: "var(--qb-main-card-bg, #18181b)" },
  primaryTab: { flex: 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, minWidth: 0, padding: "6px 8px", border: 0, borderRadius: 5, background: "transparent", color: "var(--qb-main-meta)", cursor: "pointer", fontSize: 11, fontWeight: 650 },
  primaryTabActive: { background: "color-mix(in srgb, var(--qb-info, #60a5fa) 18%, transparent)", color: "var(--qb-body-fg)", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--qb-info, #60a5fa) 45%, transparent)" },
  summary: { margin: "10px 0", color: "var(--qb-main-meta)", fontSize: 12, lineHeight: 1.5 },
  addRow: { display: "flex", gap: 6, marginBottom: 10 },
  symbolInput: { minWidth: 0, flex: 1.2, ...inputStyle },
  exchangeInput: { minWidth: 0, flex: 0.8, ...inputStyle },
  addButton: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, padding: 0 },
  marketFilterBar: { display: "flex", gap: 6, overflowX: "auto", paddingBottom: 7, marginTop: 1, scrollbarWidth: "thin" },
  marketFilter: { flex: "0 0 auto", display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 999, padding: "4px 7px", background: "var(--qb-main-card-bg, #18181b)", color: "var(--qb-main-meta, #a1a1aa)", fontSize: 10, cursor: "pointer", whiteSpace: "nowrap" },
  marketFilterActive: { borderColor: "var(--qb-info, #60a5fa)", color: "var(--qb-info, #60a5fa)", background: "color-mix(in srgb, var(--qb-info, #60a5fa) 10%, transparent)" },
  filterSummary: { margin: "0 0 6px", color: "var(--qb-main-meta)", fontSize: 10, lineHeight: 1.4 },
  streamState: { display: "inline-flex", alignItems: "center", gap: 4, color: "var(--qb-main-meta)", fontSize: 10, whiteSpace: "nowrap" },
  streamStateOk: { color: "var(--qb-success, #34d399)" },
  streamStateWarn: { color: "var(--qb-warn, #f59e0b)" },
  streamDot: { width: 6, height: 6, borderRadius: "50%", background: "currentColor", boxShadow: "0 0 0 2px color-mix(in srgb, currentColor 15%, transparent)" },
  streamMeta: { flexShrink: 0, margin: "-2px 0 8px", color: "var(--qb-main-meta)", fontSize: 10, fontVariantNumeric: "tabular-nums" },
  notice: { padding: "7px 8px", marginBottom: 8, borderLeft: "2px solid var(--qb-info, #60a5fa)", color: "var(--qb-main-meta)", fontSize: 11, background: "var(--qb-main-card-bg)" },
  warning: { padding: "7px 8px", marginBottom: 8, color: "var(--qb-warn, #f59e0b)", fontSize: 11, lineHeight: 1.45, background: "color-mix(in srgb, var(--qb-warn, #f59e0b) 10%, transparent)" },
  list: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 },
  item: { display: "flex", alignItems: "center", gap: 8, padding: 8, border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 8, background: "var(--qb-main-card-bg, #18181b)" },
  itemOpen: { border: 0, padding: 0, background: "transparent", color: "inherit", textAlign: "left", cursor: "pointer", minWidth: 0, flex: 1 },
  itemTop: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  symbol: { fontFamily: "var(--qb-font-mono, ui-monospace, monospace)", fontSize: 13 },
  exchange: { fontSize: 10, color: "var(--qb-main-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  positionBadge: { marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 3, fontSize: 10, color: "var(--qb-success, #34d399)" },
  priceLine: { display: "flex", alignItems: "baseline", gap: 8, marginTop: 3 },
  price: { fontVariantNumeric: "tabular-nums", fontSize: 15, fontWeight: 650 },
  quoteMeta: { fontSize: 10, color: "var(--qb-main-meta)" },
  positionMeta: { marginTop: 4, fontSize: 10, color: "var(--qb-main-meta)", fontVariantNumeric: "tabular-nums" },
  itemChart: { flex: "0 0 78px", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 },
  miniChart: { display: "block", width: 78, height: 36, overflow: "visible" },
  miniChartEmpty: { width: 78, height: 36, display: "grid", placeItems: "center", color: "var(--qb-main-meta)", borderBottom: "1px solid var(--qb-main-card-border, #27272a)", fontSize: 12 },
  change: { minHeight: 13, color: "var(--qb-main-meta)", fontSize: 10, fontVariantNumeric: "tabular-nums", fontWeight: 650 },
  changePositive: { color: "var(--qb-success, #34d399)" },
  changeNegative: { color: "var(--qb-danger, #fb7185)" },
  removeConfirm: { display: "flex", flex: "0 0 auto", flexDirection: "column", alignItems: "stretch", gap: 3, padding: 5, border: "1px solid color-mix(in srgb, var(--qb-danger, #fb7185) 55%, transparent)", borderRadius: 6, color: "var(--qb-main-meta)", fontSize: 9, whiteSpace: "nowrap" },
  confirmDelete: { border: 0, borderRadius: 4, padding: "3px 5px", background: "var(--qb-danger, #fb7185)", color: "#fff", cursor: "pointer", fontSize: 10 },
  confirmCancel: { border: "1px solid var(--qb-main-card-border, #27272a)", borderRadius: 4, padding: "3px 5px", background: "transparent", color: "var(--qb-main-meta)", cursor: "pointer", fontSize: 10 },
  empty: { padding: "26px 10px", color: "var(--qb-main-meta)", lineHeight: 1.55, textAlign: "center", fontSize: 12 },
  footer: { flexShrink: 0, paddingTop: 10, marginTop: 8, borderTop: "1px solid var(--qb-separator)", color: "var(--qb-main-meta)", fontSize: 10, lineHeight: 1.45 },
};
