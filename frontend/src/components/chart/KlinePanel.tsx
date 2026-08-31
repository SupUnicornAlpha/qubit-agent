import type { FC, FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { getKlines, getOptionChain, listMarketDataSources } from "../../api/backend";
import type {
  KlineBar,
  KlinesErrorPayload,
  KlinesResponseMeta,
  MarketDataReadiness,
  MarketDataSourceRecord,
  MarketStreamEvent,
  OptionChain,
} from "../../api/types";
import { backendWebSocketUrl } from "../../api/client";
import {
  CHART_TIMEFRAMES,
  chartControlStyle,
  guessChartExchangeFromSymbol,
} from "../../lib/chartSpec";
import {
  formatKlinesErrorMessage,
  formatKlinesErrorTail,
  isKlinesErrorPayload,
  parseKlinesApiError,
} from "../../lib/klinesError";
import { ChartMarketSelect } from "./ChartMarketSelect";
import type { TraderMarkerRecord } from "../../store";
import { useAppStore } from "../../store";
import { useTranslation } from "../../i18n";
import { NewsBriefSection } from "./NewsBriefSection";
import { bollinger, kdj, macd, rsi, vwap } from "../../lib/technicalIndicators";
import {
  barsToCandles,
  barsToVolume,
  histogramFromValues,
  lineFromEma,
  lineFromSma,
  lineFromValues,
  normalizeKlineBars,
  toChartTime,
} from "../../lib/klineSeries";
import { applyDefaultKlineViewport } from "../../lib/klineViewport";

function markerToChartTime(
  m: TraderMarkerRecord,
  lastBars: KlineBar[],
  timeframe: string,
): Time | null {
  if (m.barTime) {
    const tf = timeframe.toLowerCase();
    if (tf === "1d" || tf === "1w") {
      const d = m.barTime.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d as Time;
    }
    const ms = Date.parse(m.barTime);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000) as UTCTimestamp;
  }
  const match = lastBars.find(
    (b) =>
      b.timestamp === m.barTime ||
      b.timestamp.startsWith(m.barTime?.slice(0, 10) ?? ""),
  );
  if (match) return toChartTime(match, timeframe);
  if (lastBars.length > 0)
    return toChartTime(lastBars[lastBars.length - 1]!, timeframe);
  return null;
}

type ChartTheme = {
  options: {
    layout: { background: { type: ColorType.Solid; color: string }; textColor: string };
    grid: { vertLines: { color: string }; horzLines: { color: string } };
    rightPriceScale: { borderColor: string };
    timeScale: { borderColor: string; timeVisible: true; secondsVisible: false };
  };
  candleUp: string;
  candleDown: string;
  indicatorPrimary: string;
  indicatorSecondary: string;
  indicatorBand: string;
  indicatorMid: string;
  indicatorSignal: string;
};

function chartTheme(): ChartTheme {
  const computed = typeof document === "undefined" ? null : getComputedStyle(document.documentElement);
  const colorScheme = computed?.colorScheme ?? "dark";
  const light = colorScheme.includes("light");
  const token = (name: string, fallback: string) => computed?.getPropertyValue(name).trim() || fallback;
  const fallback = light
    ? { bg: "#ffffff", text: "#475569", grid: "#e2e8f0", border: "#cbd5e1" }
    : { bg: "#0c0c0e", text: "#a1a1aa", grid: "#27272a", border: "#3f3f46" };
  return {
    options: {
      layout: {
        background: { type: ColorType.Solid, color: token("--qb-chart-bg", token("--qb-kline-root-bg", fallback.bg)) },
        textColor: token("--qb-chart-text", token("--qb-main-meta", fallback.text)),
      },
      grid: {
        vertLines: { color: token("--qb-chart-grid", fallback.grid) },
        horzLines: { color: token("--qb-chart-grid", fallback.grid) },
      },
      rightPriceScale: { borderColor: token("--qb-chart-border", token("--qb-kline-header-border", fallback.border)) },
      timeScale: {
        borderColor: token("--qb-chart-border", token("--qb-kline-header-border", fallback.border)),
        timeVisible: true,
        secondsVisible: false,
      },
    },
    candleUp: token("--qb-chart-candle-up", "#26a69a"),
    candleDown: token("--qb-chart-candle-down", "#ef5350"),
    indicatorPrimary: token("--qb-chart-indicator-primary", "rgba(59, 130, 246, 0.92)"),
    indicatorSecondary: token("--qb-chart-indicator-secondary", "rgba(168, 85, 247, 0.92)"),
    indicatorBand: token("--qb-chart-indicator-band", "rgba(14, 165, 233, 0.72)"),
    indicatorMid: token("--qb-chart-indicator-mid", "rgba(148, 163, 184, 0.68)"),
    indicatorSignal: token("--qb-chart-indicator-signal", "rgba(245, 158, 11, 0.95)"),
  };
}

type ChartPaneKind = "volume" | "macd" | "rsi" | "kdj";
type PaneRegistrar = (id: string, chart: IChartApi) => () => void;

const paneTitles: Record<ChartPaneKind, string> = {
  volume: "VOL · 成交量",
  macd: "MACD (12, 26, 9)",
  rsi: "RSI (14)",
  kdj: "KDJ (9, 3, 3)",
};

/**
 * lightweight-charts 4.x 没有原生 pane API。每个副图使用独立 chart，并由父级
 * 同步可见区间；这既保留了库的交叉光标/缩放体验，也不会把不同量纲压进主图。
 */
const IndicatorPane: FC<{
  kind: ChartPaneKind;
  bars: KlineBar[];
  timeframe: string;
  showTimeScale: boolean;
  uiStyle: string;
  registerPane: PaneRegistrar;
}> = ({ kind, bars, timeframe, showTimeScale, uiStyle, registerPane }) => {
  const paneRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const primaryRef = useRef<ISeriesApi<"Line"> | ISeriesApi<"Histogram"> | null>(null);
  const secondaryRef = useRef<ISeriesApi<"Line"> | null>(null);
  const tertiaryRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const colors = chartTheme();
    const chart = createChart(el, {
      ...colors.options,
      crosshair: { mode: CrosshairMode.Normal },
      width: el.clientWidth,
      height: el.clientHeight,
      rightPriceScale: { ...colors.options.rightPriceScale, minimumWidth: 58 },
      timeScale: { ...colors.options.timeScale, visible: showTimeScale },
    });
    if (kind === "volume") {
      primaryRef.current = chart.addHistogramSeries({
        priceFormat: { type: "volume" },
        title: "VOL",
      });
    } else if (kind === "macd") {
      primaryRef.current = chart.addHistogramSeries({ title: "Histogram" });
      secondaryRef.current = chart.addLineSeries({ color: colors.indicatorPrimary, lineWidth: 2, title: "DIF" });
      tertiaryRef.current = chart.addLineSeries({ color: colors.indicatorSignal, lineWidth: 1, title: "DEA" });
    } else if (kind === "rsi") {
      primaryRef.current = chart.addLineSeries({ color: colors.indicatorSignal, lineWidth: 2, title: "RSI14" });
    } else {
      primaryRef.current = chart.addLineSeries({ color: colors.indicatorSignal, lineWidth: 2, title: "K" });
      secondaryRef.current = chart.addLineSeries({ color: colors.indicatorPrimary, lineWidth: 2, title: "D" });
      tertiaryRef.current = chart.addLineSeries({ color: colors.indicatorSecondary, lineWidth: 1, title: "J" });
    }
    chartRef.current = chart;
    const unregister = registerPane(kind, chart);
    const resize = () => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => {
      observer.disconnect();
      unregister();
      chart.remove();
      chartRef.current = null;
      primaryRef.current = null;
      secondaryRef.current = null;
      tertiaryRef.current = null;
    };
  }, [kind, registerPane]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const colors = chartTheme();
    chart.applyOptions({
      ...colors.options,
      timeScale: { ...colors.options.timeScale, visible: showTimeScale },
    });
    if (kind === "macd") {
      secondaryRef.current?.applyOptions({ color: colors.indicatorPrimary });
      tertiaryRef.current?.applyOptions({ color: colors.indicatorSignal });
    } else if (kind === "rsi") {
      primaryRef.current?.applyOptions({ color: colors.indicatorSignal });
    } else if (kind === "kdj") {
      primaryRef.current?.applyOptions({ color: colors.indicatorSignal });
      secondaryRef.current?.applyOptions({ color: colors.indicatorPrimary });
      tertiaryRef.current?.applyOptions({ color: colors.indicatorSecondary });
    }
  }, [kind, showTimeScale, uiStyle]);

  useEffect(() => {
    if (kind === "volume") {
      (primaryRef.current as ISeriesApi<"Histogram"> | null)?.setData(barsToVolume(bars, timeframe));
      return;
    }
    const closes = bars.map((bar) => bar.close);
    if (kind === "macd") {
      const series = macd(closes);
      (primaryRef.current as ISeriesApi<"Histogram"> | null)?.setData(histogramFromValues(bars, timeframe, series.histogram));
      secondaryRef.current?.setData(lineFromValues(bars, timeframe, series.macd));
      tertiaryRef.current?.setData(lineFromValues(bars, timeframe, series.signal));
    } else if (kind === "rsi") {
      (primaryRef.current as ISeriesApi<"Line"> | null)?.setData(lineFromValues(bars, timeframe, rsi(closes, 14)));
    } else {
      const series = kdj(bars);
      (primaryRef.current as ISeriesApi<"Line"> | null)?.setData(lineFromValues(bars, timeframe, series.k));
      secondaryRef.current?.setData(lineFromValues(bars, timeframe, series.d));
      tertiaryRef.current?.setData(lineFromValues(bars, timeframe, series.j));
    }
  }, [bars, kind, timeframe]);

  return (
    <section style={styles.indicatorPane} aria-label={paneTitles[kind]}>
      <div style={styles.indicatorPaneHeader}>
        <strong>{paneTitles[kind]}</strong>
        <span>{kind === "volume" ? "独立成交量窗格" : "与主图同步"}</span>
      </div>
      <div ref={paneRef} style={styles.indicatorPaneCanvas} />
    </section>
  );
};

export const KlinePanel: FC<{
  embedded?: boolean;
  linkTraderMarkers?: boolean;
  /** Additional markers supplied by a strategy workspace (for example runtime signal logs). */
  strategyMarkers?: TraderMarkerRecord[];
}> = ({ embedded, linkTraderMarkers, strategyMarkers = [] }) => {
  const chartSpec = useAppStore((s) => s.chartSpec);
  const setChartSpec = useAppStore((s) => s.setChartSpec);
  const chartReloadNonce = useAppStore((s) => s.chartReloadNonce);
  const requestChartReload = useAppStore((s) => s.requestChartReload);
  const setChartContext = useAppStore((s) => s.setChartContext);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setConfigSubPage = useAppStore((s) => s.setConfigSubPage);
  const activeView = useAppStore((s) => s.activeView);
  const traderMarkers = useAppStore((s) => s.traderMarkers);
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const smaLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vwapLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbMiddleRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const paneChartsRef = useRef(new Map<string, IChartApi>());
  const syncingTimeScaleRef = useRef(false);
  const fittedChartKeyRef = useRef<string | null>(null);
  /** 记录上次 fit 时的 bar 数；WS 先推 1 根 provisional bar 时不应锁死视口。 */
  const fittedBarCountRef = useRef(0);
  const klineLoadKeyRef = useRef("");

  const chartOverlays = useAppStore((s) => s.chartOverlays);
  const uiStyle = useAppStore((s) => s.uiStyle);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [klinesError, setKlinesError] = useState<KlinesErrorPayload | null>(
    null,
  );
  const [meta, setMeta] = useState<KlinesResponseMeta | null>(null);
  const [lastBars, setLastBars] = useState<KlineBar[]>([]);
  const [sourceRows, setSourceRows] = useState<MarketDataSourceRecord[]>([]);
  const [readiness, setReadiness] = useState<MarketDataReadiness | null>(null);
  const [optionChain, setOptionChain] = useState<OptionChain | null>(null);
  const [optionChainError, setOptionChainError] = useState<string | null>(null);

  const layoutChart = useCallback(() => {
    const el = wrapRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;
    const w = el.clientWidth;
    const h = embedded
      ? Math.max(120, el.clientHeight)
      : Math.max(160, el.clientHeight);
    chart.applyOptions({ width: w, height: h });
  }, [embedded]);

  const registerPane = useCallback<PaneRegistrar>((id, chart) => {
    paneChartsRef.current.set(id, chart);
    const primaryRange = paneChartsRef.current.get("price")?.timeScale().getVisibleLogicalRange();
    if (id !== "price" && primaryRange != null) {
      chart.timeScale().setVisibleLogicalRange(primaryRange);
    }
    const syncRange = (range: LogicalRange | null) => {
      if (range == null || syncingTimeScaleRef.current) return;
      syncingTimeScaleRef.current = true;
      for (const [otherId, otherChart] of paneChartsRef.current) {
        if (otherId !== id) otherChart.timeScale().setVisibleLogicalRange(range);
      }
      syncingTimeScaleRef.current = false;
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(syncRange);
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(syncRange);
      paneChartsRef.current.delete(id);
    };
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const colors = chartTheme();
    const chart = createChart(el, {
      ...colors.options,
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { ...colors.options.timeScale, visible: false },
      width: el.clientWidth,
      height: embedded
        ? Math.max(120, el.clientHeight)
        : Math.max(200, el.clientHeight),
    });

    const candle = chart.addCandlestickSeries({
      upColor: colors.candleUp,
      downColor: colors.candleDown,
      borderVisible: false,
      wickUpColor: colors.candleUp,
      wickDownColor: colors.candleDown,
    });

    const smaLine = chart.addLineSeries({
      color: colors.indicatorPrimary,
      lineWidth: 2,
      title: "SMA20",
    });
    const emaLine = chart.addLineSeries({
      color: colors.indicatorSecondary,
      lineWidth: 2,
      title: "EMA20",
    });
    const vwapLine = chart.addLineSeries({
      color: colors.indicatorSignal,
      lineWidth: 2,
      title: "VWAP",
    });
    const bbUpper = chart.addLineSeries({
      color: colors.indicatorBand,
      lineWidth: 1,
      title: "BB Upper",
    });
    const bbMiddle = chart.addLineSeries({
      color: colors.indicatorMid,
      lineWidth: 1,
      title: "BB Middle",
    });
    const bbLower = chart.addLineSeries({
      color: colors.indicatorBand,
      lineWidth: 1,
      title: "BB Lower",
    });
    smaLineRef.current = smaLine;
    emaLineRef.current = emaLine;
    vwapLineRef.current = vwapLine;
    bbUpperRef.current = bbUpper;
    bbMiddleRef.current = bbMiddle;
    bbLowerRef.current = bbLower;
    chartRef.current = chart;
    candleRef.current = candle;
    const unregister = registerPane("price", chart);

    const ro = new ResizeObserver(() => layoutChart());
    ro.observe(el);

    return () => {
      ro.disconnect();
      unregister();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      smaLineRef.current = null;
      emaLineRef.current = null;
      vwapLineRef.current = null;
      bbUpperRef.current = null;
      bbMiddleRef.current = null;
      bbLowerRef.current = null;
    };
  }, [layoutChart, embedded, registerPane]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const colors = chartTheme();
    chart.applyOptions(colors.options);
    candleRef.current?.applyOptions({
      upColor: colors.candleUp,
      downColor: colors.candleDown,
      wickUpColor: colors.candleUp,
      wickDownColor: colors.candleDown,
    });
    smaLineRef.current?.applyOptions({ color: colors.indicatorPrimary });
    emaLineRef.current?.applyOptions({ color: colors.indicatorSecondary });
    vwapLineRef.current?.applyOptions({ color: colors.indicatorSignal });
    bbUpperRef.current?.applyOptions({ color: colors.indicatorBand });
    bbMiddleRef.current?.applyOptions({ color: colors.indicatorMid });
    bbLowerRef.current?.applyOptions({ color: colors.indicatorBand });
  }, [uiStyle]);

  const load = useCallback(async () => {
    const spec = useAppStore.getState().chartSpec;
    const loadKey = `${spec.symbol}|${spec.exchange}|${spec.timeframe}`;
    if (klineLoadKeyRef.current !== loadKey) {
      setLastBars([]);
      klineLoadKeyRef.current = loadKey;
    }
    setLoading(true);
    setError(null);
    setKlinesError(null);
    try {
      const res = await getKlines({
        symbol: spec.symbol.trim(),
        exchange: spec.exchange.trim() || undefined,
        timeframe: spec.timeframe,
        limit: spec.limit,
      });
      void listMarketDataSources()
        .then((control) => {
          setSourceRows(control.data);
          setReadiness(control.readiness);
        })
        .catch(() => undefined);
      if (!res.ok || !Array.isArray(res.data)) {
        const wrapped = parseKlinesApiError(res);
        if (wrapped) {
          setKlinesError(wrapped);
          setError(formatKlinesErrorMessage(wrapped));
        } else {
          setError("Unexpected response");
        }
        return;
      }
      setMeta(res.meta);
      if (res.data.length === 0) {
        const wrapped = isKlinesErrorPayload(res.error) ? res.error : null;
        if (wrapped) {
          setKlinesError(wrapped);
          setError(formatKlinesErrorMessage(wrapped));
        }
        candleRef.current?.setData([]);
        smaLineRef.current?.setData([]);
        emaLineRef.current?.setData([]);
        vwapLineRef.current?.setData([]);
        bbUpperRef.current?.setData([]);
        bbMiddleRef.current?.setData([]);
        bbLowerRef.current?.setData([]);
        return;
      }
      const normalized = normalizeKlineBars(
        res.data,
        spec.timeframe,
        spec.limit,
      );
      if (normalized.length === 0) {
        setError("行情数据包含无效或重复时间戳，无法绘制 K 线");
      }
      // A live backfill may populate a few provisional candles before the
      // authoritative history returns. Always reset the initial viewport here.
      fittedChartKeyRef.current = null;
      fittedBarCountRef.current = 0;
      setLastBars(normalized);
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try {
        const jsonStart = msg.indexOf("{");
        if (jsonStart >= 0) {
          const parsed = JSON.parse(msg.slice(jsonStart)) as {
            error?: unknown;
          };
          const wrapped = parseKlinesApiError(parsed);
          if (wrapped) {
            setKlinesError(wrapped);
            setError(formatKlinesErrorMessage(wrapped));
            return;
          }
        }
      } catch {
        /* use raw message */
      }
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [
    chartSpec.symbol,
    chartSpec.exchange,
    chartSpec.timeframe,
    chartSpec.limit,
    load,
  ]);

  useEffect(() => {
    if (!["OPRA", "US", "HK", "HKEX"].includes(chartSpec.exchange) || !chartSpec.symbol.trim()) {
      setOptionChain(null);
      setOptionChainError(null);
      return;
    }
    let cancelled = false;
    setOptionChain(null);
    setOptionChainError(null);
    void getOptionChain({
      symbol: chartSpec.symbol.trim(),
      exchange: chartSpec.exchange,
      source: "auto",
    })
      .then((chain) => {
        if (!cancelled) setOptionChain(chain);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setOptionChainError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chartSpec.exchange, chartSpec.symbol]);

  useEffect(() => {
    if (chartReloadNonce === 0) return;
    void load();
  }, [chartReloadNonce, load]);

  useEffect(() => {
    const spec = chartSpec;
    if (!spec.symbol.trim()) return;
    let socket: WebSocket | null = null;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let staleTimer: ReturnType<typeof setInterval> | null = null;
    let reconnectAttempt = 0;
    let lastMessageAt = Date.now();
    let lastSequence = 0;

    const applyBackfill = (bars: KlineBar[]) => {
      if (bars.length === 0) return;
      // Backfill is a short live-recovery window (normally 120 bars), not a full
      // replacement for the long history loaded by /market/klines.
      setLastBars((current) =>
        normalizeKlineBars([...current, ...bars], spec.timeframe, spec.limit),
      );
    };

    const applyBar = (bar: KlineBar) => {
      const eventSymbol = bar.symbol?.trim().toUpperCase();
      const eventExchange = bar.exchange?.trim().toUpperCase();
      if (
        (eventSymbol && eventSymbol !== spec.symbol.trim().toUpperCase()) ||
        (eventExchange &&
          spec.exchange.trim() &&
          eventExchange !== spec.exchange.trim().toUpperCase())
      ) {
        return;
      }
      setLastBars((current) =>
        normalizeKlineBars([...current, bar], spec.timeframe, spec.limit),
      );
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      reconnectAttempt += 1;
      const delayMs = Math.min(
        15_000,
        500 * 2 ** Math.min(reconnectAttempt, 5),
      );
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (disposed) return;
      socket = new WebSocket(backendWebSocketUrl("market"));
      socket.addEventListener("open", () => {
        reconnectAttempt = 0;
        lastMessageAt = Date.now();
        socket?.send(
          JSON.stringify({
            action: "subscribe_market",
            subscription: {
              symbol: spec.symbol.trim(),
              exchange: spec.exchange.trim(),
              timeframe: spec.timeframe,
              channels: ["quote", "bar"],
            },
          }),
        );
      });
      socket.addEventListener("message", (message) => {
        lastMessageAt = Date.now();
        try {
          const envelope = JSON.parse(String(message.data)) as {
            topic?: string;
            payload?: MarketStreamEvent;
          };
          const event = envelope.payload;
          if (envelope.topic !== "market" || !event?.kind) return;
          if (
            event.sequence > 0 &&
            lastSequence > 0 &&
            event.sequence > lastSequence + 1
          ) {
            requestChartReload();
          }
          if (event.sequence > 0) lastSequence = event.sequence;
          if (event.kind === "backfill" && Array.isArray(event.data)) {
            applyBackfill(event.data as KlineBar[]);
          } else if (
            event.kind === "bar" &&
            event.data &&
            typeof event.data === "object"
          ) {
            applyBar(event.data as KlineBar);
          } else if (
            event.kind === "quote" &&
            event.data &&
            typeof event.data === "object"
          ) {
            // `bar` events are built by the gateway from this quote stream.  Do
            // not mutate a historical candle from a raw quote as that can blend
            // stale or cross-contract prices into its OHLC range.
          }
        } catch {
          /* ignore malformed market stream events */
        }
      });
      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    staleTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > 45_000) socket?.close();
      else if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "ping" }));
      }
    }, 15_000);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (staleTimer) clearInterval(staleTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ action: "unsubscribe_market" }));
      }
      socket?.close();
    };
  }, [
    chartSpec.symbol,
    chartSpec.exchange,
    chartSpec.timeframe,
    chartSpec.limit,
    requestChartReload,
  ]);

  useEffect(() => {
    try {
      const tf = chartSpec.timeframe;
      candleRef.current?.setData(barsToCandles(lastBars, tf));
      if (lastBars.length === 0) {
        smaLineRef.current?.setData([]);
        emaLineRef.current?.setData([]);
        vwapLineRef.current?.setData([]);
        bbUpperRef.current?.setData([]);
        bbMiddleRef.current?.setData([]);
        bbLowerRef.current?.setData([]);
        return;
      }
      const { sma20, ema20, vwap: showVwap, bb20 } = chartOverlays;
      const closes = lastBars.map((bar) => bar.close);
      smaLineRef.current?.setData(
        sma20 && lastBars.length >= 20 ? lineFromSma(lastBars, tf, 20) : [],
      );
      emaLineRef.current?.setData(
        ema20 && lastBars.length >= 20 ? lineFromEma(lastBars, tf, 20) : [],
      );
      vwapLineRef.current?.setData(
        showVwap ? lineFromValues(lastBars, tf, vwap(lastBars)) : [],
      );
      const bb = bollinger(closes, 20, 2);
      bbUpperRef.current?.setData(
        bb20 ? lineFromValues(lastBars, tf, bb.upper) : [],
      );
      bbMiddleRef.current?.setData(
        bb20 ? lineFromValues(lastBars, tf, bb.middle) : [],
      );
      bbLowerRef.current?.setData(
        bb20 ? lineFromValues(lastBars, tf, bb.lower) : [],
      );
    } catch (chartError) {
      const message =
        chartError instanceof Error ? chartError.message : String(chartError);
      setError(`K线渲染失败：${message}`);
    }
  }, [chartOverlays, lastBars, chartSpec.timeframe]);

  useEffect(() => {
    const fitKey = `${chartSpec.symbol}|${chartSpec.exchange}|${chartSpec.timeframe}|${chartSpec.limit}`;
    if (lastBars.length === 0) return;
    const specChanged = fittedChartKeyRef.current !== fitKey;
    const sparseThenFilled =
      lastBars.length >= 8 && fittedBarCountRef.current > 0 && fittedBarCountRef.current < 8;
    const historyExpanded =
      lastBars.length >= 32 &&
      fittedBarCountRef.current > 0 &&
      fittedBarCountRef.current < Math.min(lastBars.length, 32);
    if (!specChanged && !sparseThenFilled && !historyExpanded) return;
    const frame = requestAnimationFrame(() => {
      const priceChart = paneChartsRef.current.get("price");
      if (!priceChart) return;
      const range = applyDefaultKlineViewport(priceChart, lastBars.length);
      if (range != null) {
        for (const [id, paneChart] of paneChartsRef.current) {
          if (id !== "price") paneChart.timeScale().setVisibleLogicalRange(range);
        }
      }
      fittedChartKeyRef.current = fitKey;
      fittedBarCountRef.current = lastBars.length;
    });
    return () => cancelAnimationFrame(frame);
  }, [chartSpec.exchange, chartSpec.limit, chartSpec.symbol, chartSpec.timeframe, lastBars]);

  const bringToChat = () => {
    const spec = useAppStore.getState().chartSpec;
    const last = lastBars[lastBars.length - 1];
    const summary = last
      ? t("chart.kline.ohlcTail", {
          o: last.open.toFixed(4),
          h: last.high.toFixed(4),
          l: last.low.toFixed(4),
          c: last.close.toFixed(4),
          v: Math.round(last.volume),
        }).replace(/^ · /, "")
      : undefined;
    setChartContext({
      symbol: spec.symbol.trim(),
      exchange: spec.exchange.trim(),
      timeframe: spec.timeframe,
      limit: spec.limit,
      summary,
      fetchedAt: new Date().toISOString(),
    });
    setActiveView(activeView === "ide" ? "ide" : "team");
  };

  useEffect(() => {
    window.addEventListener("resize", layoutChart);
    return () => window.removeEventListener("resize", layoutChart);
  }, [layoutChart]);

  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    const mergedMarkers = [
      ...(linkTraderMarkers ? traderMarkers : []),
      ...strategyMarkers,
    ].filter(
      (marker, index, all) =>
        all.findIndex((item) => item.id === marker.id) === index,
    );
    if (mergedMarkers.length === 0) {
      c.setMarkers([]);
      return;
    }
    if (lastBars.length === 0) {
      c.setMarkers([]);
      return;
    }
    const markers: SeriesMarker<Time>[] = mergedMarkers.flatMap((m) => {
      const time = markerToChartTime(m, lastBars, chartSpec.timeframe);
      if (time == null) return [];
      return [
        {
          id: m.id,
          time,
          position: m.side === "buy" ? "belowBar" : "aboveBar",
          shape: m.side === "buy" ? "arrowUp" : "arrowDown",
          color:
            m.source === "agent"
              ? "#a78bfa"
              : m.source === "strategy"
                ? "#38bdf8"
                : m.side === "buy"
                  ? "#22c55e"
                  : "#f87171",
          text: m.text.length > 24 ? `${m.text.slice(0, 24)}…` : m.text,
        },
      ];
    });
    c.setMarkers(markers);
  }, [
    linkTraderMarkers,
    traderMarkers,
    strategyMarkers,
    lastBars,
    chartSpec.timeframe,
  ]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    requestChartReload();
  };

  const errTail = klinesError ? ` · ${formatKlinesErrorTail(klinesError)}` : "";
  const loadingTail = loading ? t("chart.kline.loadingTail") : "";
  const metaStatusLine = meta
    ? embedded
      ? t("chart.kline.sourceCompact", {
          source: meta.dataSource,
          got: meta.returned,
          want: meta.requestedLimit,
          loadingTail: loadingTail + errTail,
        })
      : t("chart.kline.sourceFull", {
          source: meta.dataSource,
          tf: meta.timeframe,
          period: meta.period,
          got: meta.returned,
          want: meta.requestedLimit,
          tail: errTail,
        })
    : null;
  const activeSource = meta
    ? (sourceRows.find((source) => source.id === meta.dataSource) ?? null)
    : null;
  const openDataSourceSettings = () => {
    setConfigSubPage("providers");
    setActiveView("config");
  };
  const visiblePaneKinds: ChartPaneKind[] = [
    "volume",
    ...(chartOverlays.macd ? ["macd" as const] : []),
    ...(chartOverlays.rsi14 ? ["rsi" as const] : []),
    ...(chartOverlays.kdj ? ["kdj" as const] : []),
  ];
  const chartStack = (
    <div style={styles.chartStack}>
      <div ref={wrapRef} style={styles.priceChartCanvas} />
      {visiblePaneKinds.map((kind, index) => (
        <IndicatorPane
          key={kind}
          kind={kind}
          bars={lastBars}
          timeframe={chartSpec.timeframe}
          uiStyle={uiStyle}
          showTimeScale={index === visiblePaneKinds.length - 1}
          registerPane={registerPane}
        />
      ))}
    </div>
  );

  return (
    <div
      style={embedded ? styles.root : styles.rootPage}
      data-qb-chart-surface
      {...(!embedded ? { "data-qb-news-page": true } : {})}
    >
      {embedded ? (
        <div style={styles.embeddedBar}>
          {error ? <div style={styles.errCompact}>{error}</div> : null}
          {metaStatusLine ? (
            <div style={styles.metaCompact}>{metaStatusLine}</div>
          ) : loading ? (
            <div style={styles.metaCompact}>{t("common.status.loading")}</div>
          ) : null}
          <button
            type="button"
            className="qb-btn-secondary qb-btn--compact"
            disabled={loading || lastBars.length === 0}
            onClick={bringToChat}
          >
            {t("chart.kline.importToChat")}
          </button>
        </div>
      ) : (
        <header style={styles.header}>
          <h1 style={styles.title}>{t("chart.kline.title")}</h1>
          <form style={styles.form} onSubmit={onSubmit}>
            <label style={styles.lab}>
              {t("chart.kline.codeLabel")}
              <input
                style={styles.field}
                value={chartSpec.symbol}
                onChange={(e) => {
                  const symbol = e.target.value;
                  setChartSpec({ symbol, exchange: guessChartExchangeFromSymbol(symbol) });
                }}
                placeholder="600000"
              />
            </label>
            <label style={styles.lab}>
              {t("chart.kline.marketLabel")}
              <ChartMarketSelect
                style={styles.field}
                value={chartSpec.exchange}
                onChange={(exchange) => setChartSpec({ exchange })}
              />
            </label>
            <label style={styles.lab}>
              {t("chart.kline.periodLabel")}
              <select
                style={styles.field}
                value={chartSpec.timeframe}
                onChange={(e) => setChartSpec({ timeframe: e.target.value })}
              >
                {CHART_TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.lab}>
              {t("chart.kline.barsLabel")}
              <input
                style={styles.field}
                type="number"
                min={1}
                max={2000}
                value={chartSpec.limit}
                onChange={(e) =>
                  setChartSpec({ limit: Number(e.target.value) || 120 })
                }
              />
            </label>
            <button type="submit" className="qb-btn-primary" disabled={loading}>
              {loading
                ? t("common.status.loading")
                : t("common.action.refresh")}
            </button>
            <button
              type="button"
              className="qb-btn-secondary"
              disabled={loading || lastBars.length === 0}
              onClick={bringToChat}
            >
              {t("chart.kline.importToChat")}
            </button>
          </form>
        </header>
      )}
      {!embedded ? (
        <div style={styles.chartColumn}>
          {readiness && readiness.status !== "ready" ? (
            <div
              style={{
                ...styles.sourceBanner,
                ...(readiness.status === "down"
                  ? styles.sourceDown
                  : styles.sourceDegraded),
              }}
              role="status"
            >
              <div>
                <strong>
                  {readiness.status === "down"
                    ? "行情源不可用"
                    : "行情源部分可用"}
                </strong>
                <span style={styles.sourceMessage}>{readiness.message}</span>
              </div>
              <button
                type="button"
                className="qb-btn-secondary"
                onClick={openDataSourceSettings}
              >
                查看数据源
              </button>
            </div>
          ) : null}
          {error ? <div style={styles.err}>{error}</div> : null}
          {metaStatusLine ? (
            <div style={styles.meta}>{metaStatusLine}</div>
          ) : null}
          {activeSource ? (
            <div style={styles.sourceDetail}>
              <span>
                实际源：<strong>{activeSource.name}</strong>
              </span>
              <span>健康 {activeSource.healthStatus}</span>
              <span>
                成功率{" "}
                {activeSource.successRate == null
                  ? "—"
                  : `${Math.round(activeSource.successRate * 100)}%`}
              </span>
              <span>
                P95{" "}
                {activeSource.p95LatencyMs == null
                  ? "—"
                  : `${activeSource.p95LatencyMs}ms`}
              </span>
              <span>熔断 {activeSource.circuitState}</span>
              {activeSource.isFallback ? <span>已降级命中</span> : null}
            </div>
          ) : null}
          {chartStack}
          {["OPRA", "US", "HK", "HKEX"].includes(chartSpec.exchange) ? (
            <OptionChainPreview chain={optionChain} error={optionChainError} />
          ) : null}
        </div>
      ) : (
        <div style={{ ...styles.chartWrap, minHeight: 0, flex: 1 }}>
          {chartStack}
        </div>
      )}
      {!embedded ? (
        <NewsBriefSection
          symbol={chartSpec.symbol}
          exchange={chartSpec.exchange}
          reloadNonce={chartReloadNonce}
        />
      ) : null}
    </div>
  );
};

const OptionChainPreview: FC<{ chain: OptionChain | null; error: string | null }> = ({
  chain,
  error,
}) => {
  if (error) return <div style={styles.optionChainError}>期权链加载失败：{error}</div>;
  if (!chain) return <div style={styles.optionChainHint}>正在加载券商优先期权链…</div>;
  const calls = [...chain.calls].sort((a, b) => a.strike - b.strike).slice(0, 6);
  const puts = [...chain.puts].sort((a, b) => a.strike - b.strike).slice(0, 6);
  const rows = Array.from({ length: Math.max(calls.length, puts.length) }, (_, index) => ({
    call: calls[index],
    put: puts[index],
  }));
  return (
    <section style={styles.optionChain} aria-label="期权链">
      <div style={styles.optionChainTitle}>
        <strong>{chain.underlying} 期权链</strong>
        <span>
          {chain.source === "futu_opend"
            ? "富途 OpenD 券商快照 · 观察级行情"
            : "Yahoo 研究级数据 · 非实盘报价"}
        </span>
      </div>
      <div style={styles.optionChainTableWrap}>
        <table style={styles.optionChainTable}>
          <thead>
            <tr>
              <th>Call</th><th>行权价</th><th>Put</th><th>到期</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ call, put }, index) => {
              const expiry = call?.expiration ?? put?.expiration;
              return (
                <tr key={`${call?.contractSymbol ?? ""}-${put?.contractSymbol ?? index}`}>
                  <td>{call ? `${call.bid ?? "—"} / ${call.ask ?? "—"}` : "—"}</td>
                  <td>{call?.strike ?? put?.strike ?? "—"}</td>
                  <td>{put ? `${put.bid ?? "—"} / ${put.ask ?? "—"}` : "—"}</td>
                  <td>{expiry ? expiry.slice(0, 10) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const styles: Record<string, React.CSSProperties> = {
  root: {
    flex: 1,
    minWidth: 0,
    width: "100%",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    background: "var(--qb-kline-root-bg, #09090b)",
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  rootPage: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    background: "var(--qb-kline-root-bg, #09090b)",
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  chartColumn: {
    flex: "1 1 55%",
    minHeight: 200,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  },
  chartStack: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    position: "relative",
    display: "flex",
    flexDirection: "column",
    overflow: "auto",
    gap: 4,
  },
  priceChartCanvas: {
    flex: "1 1 260px",
    minHeight: 180,
    width: "100%",
    position: "relative",
  },
  header: {
    flexShrink: 0,
    padding: "12px 16px",
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
  },
  title: { margin: "0 0 10px", fontSize: 18, fontWeight: 600 },
  form: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" },
  lab: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 12,
    color: "var(--qb-main-meta, #a1a1aa)",
  },
  inp: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 13,
  },
  field: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--qb-main-input-border, #3f3f46)",
    background: "var(--qb-main-input-bg, #18181b)",
    color: "var(--qb-main-input-fg, #e4e4e7)",
    fontSize: 13,
    ...chartControlStyle,
  },
  err: { padding: "8px 16px", color: "#fca5a5", fontSize: 13 },
  errCompact: { fontSize: 11, color: "#fca5a5", flex: 1, minWidth: 0 },
  meta: {
    padding: "4px 16px 8px",
    fontSize: 12,
    color: "var(--qb-main-meta, #71717a)",
  },
  sourceBanner: {
    margin: "8px 16px 4px",
    padding: "8px 10px",
    border: "1px solid",
    borderRadius: 7,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    fontSize: 12,
  },
  sourceDegraded: {
    borderColor:
      "color-mix(in srgb, var(--qb-warning, #f59e0b) 45%, transparent)",
    background:
      "color-mix(in srgb, var(--qb-warning, #f59e0b) 9%, transparent)",
  },
  sourceDown: {
    borderColor:
      "color-mix(in srgb, var(--qb-danger, #ef4444) 45%, transparent)",
    background: "color-mix(in srgb, var(--qb-danger, #ef4444) 9%, transparent)",
  },
  sourceMessage: { marginLeft: 8, color: "var(--qb-text-muted)" },
  sourceDetail: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    padding: "0 16px 7px",
    color: "var(--qb-text-muted)",
    fontSize: 10,
  },
  optionChain: {
    margin: "0 16px 10px",
    border: "1px solid var(--qb-kline-header-border, #27272a)",
    borderRadius: 8,
    overflow: "hidden",
    fontSize: 12,
  },
  optionChainTitle: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    padding: "7px 10px",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
    color: "var(--qb-text-muted, #a1a1aa)",
  },
  optionChainTableWrap: { overflowX: "auto" },
  optionChainTable: {
    borderCollapse: "collapse",
    width: "100%",
    minWidth: 420,
    color: "var(--qb-body-fg, #e4e4e7)",
  },
  optionChainHint: { padding: "8px 16px", color: "var(--qb-text-muted, #a1a1aa)", fontSize: 12 },
  optionChainError: { padding: "8px 16px", color: "#fca5a5", fontSize: 12 },
  metaCompact: {
    fontSize: 11,
    color: "var(--qb-main-meta, #71717a)",
    flex: 1,
    minWidth: 0,
  },
  embeddedBar: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: "6px 12px",
    borderBottom: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
    flexWrap: "wrap",
  },
  chartWrap: { flex: 1, minHeight: 120, width: "100%", position: "relative" },
  indicatorPane: {
    flex: "0 0 118px",
    minHeight: 118,
    width: "100%",
    borderTop: "1px solid var(--qb-kline-header-border, #27272a)",
    background: "var(--qb-kline-root-bg, #09090b)",
    display: "flex",
    flexDirection: "column",
  },
  indicatorPaneHeader: {
    height: 24,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "0 12px",
    fontSize: 10,
    color: "var(--qb-main-meta, #a1a1aa)",
    background: "var(--qb-kline-embedded-bar-bg, #111114)",
  },
  indicatorPaneCanvas: { flex: 1, minHeight: 0, width: "100%" },
};
