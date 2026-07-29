import type { FC, FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { getKlines, listMarketDataSources } from "../../api/backend";
import type {
  KlineBar,
  KlinesErrorPayload,
  KlinesResponseMeta,
  MarketDataReadiness,
  MarketDataSourceRecord,
  MarketQuote,
  MarketStreamEvent,
} from "../../api/types";
import { backendWebSocketUrl } from "../../api/client";
import { CHART_TIMEFRAMES, chartControlStyle } from "../../lib/chartSpec";
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
import { bollinger, macd, rsi } from "../../lib/technicalIndicators";
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

function markerToChartTime(m: TraderMarkerRecord, lastBars: KlineBar[], timeframe: string): Time | null {
  if (m.barTime) {
    const tf = timeframe.toLowerCase();
    if (tf === "1d" || tf === "1w") {
      const d = m.barTime.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d as Time;
    }
    const ms = Date.parse(m.barTime);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000) as UTCTimestamp;
  }
  const match = lastBars.find((b) => b.timestamp === m.barTime || b.timestamp.startsWith(m.barTime?.slice(0, 10) ?? ""));
  if (match) return toChartTime(match, timeframe);
  if (lastBars.length > 0) return toChartTime(lastBars[lastBars.length - 1]!, timeframe);
  return null;
}

function chartThemeOptions(light: boolean) {
  if (light) {
    return {
      layout: {
        background: { type: ColorType.Solid, color: "#ffffff" },
        textColor: "#475569",
      },
      grid: {
        vertLines: { color: "#e2e8f0" },
        horzLines: { color: "#e2e8f0" },
      },
      rightPriceScale: { borderColor: "#cbd5e1" },
      timeScale: { borderColor: "#cbd5e1", timeVisible: true, secondsVisible: false },
    };
  }
  return {
    layout: {
      background: { type: ColorType.Solid, color: "#0c0c0e" },
      textColor: "#a1a1aa",
    },
    grid: {
      vertLines: { color: "#27272a" },
      horzLines: { color: "#27272a" },
    },
    rightPriceScale: { borderColor: "#3f3f46" },
    timeScale: { borderColor: "#3f3f46", timeVisible: true, secondsVisible: false },
  };
}

export const KlinePanel: FC<{ embedded?: boolean; linkTraderMarkers?: boolean }> = ({
  embedded,
  linkTraderMarkers,
}) => {
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
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const smaLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbMiddleRef = useRef<ISeriesApi<"Line"> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistogramRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const chartOverlays = useAppStore((s) => s.chartOverlays);
  const uiPalette = useAppStore((s) => s.uiPalette);
  const uiStyle = useAppStore((s) => s.uiStyle);
  const isLightChart = uiStyle === "bauhaus" || uiPalette.startsWith("light");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [klinesError, setKlinesError] = useState<KlinesErrorPayload | null>(null);
  const [meta, setMeta] = useState<KlinesResponseMeta | null>(null);
  const [lastBars, setLastBars] = useState<KlineBar[]>([]);
  const [sourceRows, setSourceRows] = useState<MarketDataSourceRecord[]>([]);
  const [readiness, setReadiness] = useState<MarketDataReadiness | null>(null);

  const layoutChart = useCallback(() => {
    const el = wrapRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;
    const w = el.clientWidth;
    const h = embedded ? Math.max(120, el.clientHeight) : Math.max(160, el.clientHeight);
    chart.applyOptions({ width: w, height: h });
    chart.timeScale().fitContent();
  }, [embedded]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const chart = createChart(el, {
      ...chartThemeOptions(isLightChart),
      crosshair: { mode: CrosshairMode.Normal },
      width: el.clientWidth,
      height: embedded ? Math.max(120, el.clientHeight) : Math.max(200, el.clientHeight),
    });

    const candle = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    const vol = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "",
    });
    chart.priceScale("").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    const smaLine = chart.addLineSeries({
      color: "rgba(59, 130, 246, 0.92)",
      lineWidth: 2,
      title: "SMA20",
    });
    const emaLine = chart.addLineSeries({
      color: "rgba(168, 85, 247, 0.92)",
      lineWidth: 2,
      title: "EMA20",
    });
    const bbUpper = chart.addLineSeries({
      color: "rgba(14, 165, 233, 0.72)",
      lineWidth: 1,
      title: "BB Upper",
    });
    const bbMiddle = chart.addLineSeries({
      color: "rgba(148, 163, 184, 0.68)",
      lineWidth: 1,
      title: "BB Middle",
    });
    const bbLower = chart.addLineSeries({
      color: "rgba(14, 165, 233, 0.72)",
      lineWidth: 1,
      title: "BB Lower",
    });
    const rsiLine = chart.addLineSeries({
      color: "rgba(245, 158, 11, 0.95)",
      lineWidth: 2,
      title: "RSI14",
      priceScaleId: "rsi",
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    const macdLine = chart.addLineSeries({
      color: "rgba(59, 130, 246, 0.95)",
      lineWidth: 2,
      title: "MACD",
      priceScaleId: "macd",
    });
    const macdSignal = chart.addLineSeries({
      color: "rgba(245, 158, 11, 0.95)",
      lineWidth: 1,
      title: "Signal",
      priceScaleId: "macd",
    });
    const macdHistogram = chart.addHistogramSeries({
      title: "MACD Hist",
      priceScaleId: "macd",
    });
    chart.priceScale("rsi").applyOptions({
      scaleMargins: { top: 0.72, bottom: 0.03 },
      autoScale: true,
    });
    chart.priceScale("macd").applyOptions({
      scaleMargins: { top: 0.72, bottom: 0.03 },
      autoScale: true,
    });
    smaLineRef.current = smaLine;
    emaLineRef.current = emaLine;
    bbUpperRef.current = bbUpper;
    bbMiddleRef.current = bbMiddle;
    bbLowerRef.current = bbLower;
    rsiRef.current = rsiLine;
    macdRef.current = macdLine;
    macdSignalRef.current = macdSignal;
    macdHistogramRef.current = macdHistogram;

    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;

    const ro = new ResizeObserver(() => layoutChart());
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      smaLineRef.current = null;
      emaLineRef.current = null;
      bbUpperRef.current = null;
      bbMiddleRef.current = null;
      bbLowerRef.current = null;
      rsiRef.current = null;
      macdRef.current = null;
      macdSignalRef.current = null;
      macdHistogramRef.current = null;
    };
  }, [layoutChart, embedded]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.applyOptions(chartThemeOptions(isLightChart));
  }, [isLightChart]);

  const load = useCallback(async () => {
    const spec = useAppStore.getState().chartSpec;
    setLoading(true);
    setError(null);
    setKlinesError(null);
    setLastBars([]);
    try {
      const control = await listMarketDataSources().catch(() => null);
      if (control) {
        setSourceRows(control.data);
        setReadiness(control.readiness);
      }
      const res = await getKlines({
        symbol: spec.symbol.trim(),
        exchange: spec.exchange.trim() || undefined,
        timeframe: spec.timeframe,
        limit: spec.limit,
      });
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
        volRef.current?.setData([]);
        smaLineRef.current?.setData([]);
        emaLineRef.current?.setData([]);
        bbUpperRef.current?.setData([]);
        bbMiddleRef.current?.setData([]);
        bbLowerRef.current?.setData([]);
        rsiRef.current?.setData([]);
        macdRef.current?.setData([]);
        macdSignalRef.current?.setData([]);
        macdHistogramRef.current?.setData([]);
        return;
      }
      const normalized = normalizeKlineBars(res.data, spec.timeframe, spec.limit);
      if (normalized.length === 0) {
        setError("行情数据包含无效或重复时间戳，无法绘制 K 线");
      }
      setLastBars(normalized);
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      try {
        const jsonStart = msg.indexOf("{");
        if (jsonStart >= 0) {
          const parsed = JSON.parse(msg.slice(jsonStart)) as { error?: unknown };
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
    const t = setTimeout(() => {
      void load();
    }, 320);
    return () => clearTimeout(t);
  }, [chartSpec.symbol, chartSpec.exchange, chartSpec.timeframe, chartSpec.limit, load]);

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
      setLastBars(normalizeKlineBars(bars, spec.timeframe, spec.limit));
    };

    const applyBar = (bar: KlineBar) => {
      setLastBars((current) =>
        normalizeKlineBars([...current, bar], spec.timeframe, spec.limit)
      );
    };

    const applyQuote = (quote: MarketQuote) => {
      setLastBars((current) => {
        if (current.length === 0 || !Number.isFinite(quote.lastPrice)) return current;
        const next = [...current];
        const previous = next[next.length - 1]!;
        const updated: KlineBar = {
          ...previous,
          close: quote.lastPrice,
          high: Math.max(previous.high, quote.lastPrice),
          low: Math.min(previous.low, quote.lastPrice),
        };
        next[next.length - 1] = updated;
        return next;
      });
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer) return;
      reconnectAttempt += 1;
      const delayMs = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttempt, 5));
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
          })
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
          if (event.sequence > 0 && lastSequence > 0 && event.sequence > lastSequence + 1) {
            requestChartReload();
          }
          if (event.sequence > 0) lastSequence = event.sequence;
          if (event.kind === "backfill" && Array.isArray(event.data)) {
            applyBackfill(event.data as KlineBar[]);
          } else if (event.kind === "bar" && event.data && typeof event.data === "object") {
            applyBar(event.data as KlineBar);
          } else if (event.kind === "quote" && event.data && typeof event.data === "object") {
            applyQuote(event.data as MarketQuote);
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
      volRef.current?.setData(barsToVolume(lastBars, tf));
      if (lastBars.length === 0) {
        smaLineRef.current?.setData([]);
        emaLineRef.current?.setData([]);
        bbUpperRef.current?.setData([]);
        bbMiddleRef.current?.setData([]);
        bbLowerRef.current?.setData([]);
        rsiRef.current?.setData([]);
        macdRef.current?.setData([]);
        macdSignalRef.current?.setData([]);
        macdHistogramRef.current?.setData([]);
        return;
      }
      const { sma20, ema20, rsi14, macd: showMacd, bb20 } = chartOverlays;
      const closes = lastBars.map((bar) => bar.close);
      smaLineRef.current?.setData(
        sma20 && lastBars.length >= 20 ? lineFromSma(lastBars, tf, 20) : []
      );
      emaLineRef.current?.setData(
        ema20 && lastBars.length >= 20 ? lineFromEma(lastBars, tf, 20) : []
      );
      const bb = bollinger(closes, 20, 2);
      bbUpperRef.current?.setData(bb20 ? lineFromValues(lastBars, tf, bb.upper) : []);
      bbMiddleRef.current?.setData(bb20 ? lineFromValues(lastBars, tf, bb.middle) : []);
      bbLowerRef.current?.setData(bb20 ? lineFromValues(lastBars, tf, bb.lower) : []);
      rsiRef.current?.setData(rsi14 ? lineFromValues(lastBars, tf, rsi(closes, 14)) : []);
      const macdSeries = macd(closes);
      macdRef.current?.setData(
        showMacd ? lineFromValues(lastBars, tf, macdSeries.macd) : []
      );
      macdSignalRef.current?.setData(
        showMacd ? lineFromValues(lastBars, tf, macdSeries.signal) : []
      );
      macdHistogramRef.current?.setData(
        showMacd ? histogramFromValues(lastBars, tf, macdSeries.histogram) : []
      );
    } catch (chartError) {
      const message =
        chartError instanceof Error ? chartError.message : String(chartError);
      setError(`K线渲染失败：${message}`);
    }
  }, [chartOverlays, lastBars, chartSpec.timeframe]);

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
    setActiveView(activeView === "ide" ? "ide" : "chat");
  };

  useEffect(() => {
    window.addEventListener("resize", layoutChart);
    return () => window.removeEventListener("resize", layoutChart);
  }, [layoutChart]);

  useEffect(() => {
    const c = candleRef.current;
    if (!c) return;
    if (!linkTraderMarkers) {
      c.setMarkers([]);
      return;
    }
    if (lastBars.length === 0) {
      c.setMarkers([]);
      return;
    }
    const markers: SeriesMarker<Time>[] = traderMarkers.flatMap((m) => {
      const time = markerToChartTime(m, lastBars, chartSpec.timeframe);
      if (time == null) return [];
      return [{
      id: m.id,
      time,
      position: m.side === "buy" ? "belowBar" : "aboveBar",
      shape: m.side === "buy" ? "arrowUp" : "arrowDown",
      color:
        m.source === "agent" ? "#a78bfa" : m.source === "strategy" ? "#38bdf8" : m.side === "buy" ? "#22c55e" : "#f87171",
      text: m.text.length > 24 ? `${m.text.slice(0, 24)}…` : m.text,
    }];
    });
    c.setMarkers(markers);
  }, [linkTraderMarkers, traderMarkers, lastBars, chartSpec.timeframe]);

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
    ? sourceRows.find((source) => source.id === meta.dataSource) ?? null
    : null;
  const openDataSourceSettings = () => {
    setConfigSubPage("providers");
    setActiveView("config");
  };

  return (
    <div
      style={embedded ? styles.root : styles.rootPage}
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
                onChange={(e) => setChartSpec({ symbol: e.target.value })}
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
                onChange={(e) => setChartSpec({ limit: Number(e.target.value) || 120 })}
              />
            </label>
            <button type="submit" className="qb-btn-primary" disabled={loading}>
              {loading ? t("common.status.loading") : t("common.action.refresh")}
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
                ...(readiness.status === "down" ? styles.sourceDown : styles.sourceDegraded),
              }}
              role="status"
            >
              <div>
                <strong>{readiness.status === "down" ? "行情源不可用" : "行情源部分可用"}</strong>
                <span style={styles.sourceMessage}>{readiness.message}</span>
              </div>
              <button type="button" className="qb-btn-secondary" onClick={openDataSourceSettings}>
                查看数据源
              </button>
            </div>
          ) : null}
          {error ? <div style={styles.err}>{error}</div> : null}
          {metaStatusLine ? <div style={styles.meta}>{metaStatusLine}</div> : null}
          {activeSource ? (
            <div style={styles.sourceDetail}>
              <span>实际源：<strong>{activeSource.name}</strong></span>
              <span>健康 {activeSource.healthStatus}</span>
              <span>成功率 {activeSource.successRate == null ? "—" : `${Math.round(activeSource.successRate * 100)}%`}</span>
              <span>P95 {activeSource.p95LatencyMs == null ? "—" : `${activeSource.p95LatencyMs}ms`}</span>
              <span>熔断 {activeSource.circuitState}</span>
              {activeSource.isFallback ? <span>已降级命中</span> : null}
            </div>
          ) : null}
          <div ref={wrapRef} style={styles.chartCanvas} />
        </div>
      ) : (
        <div
          ref={wrapRef}
          style={{
            ...styles.chartWrap,
            minHeight: 0,
            flex: 1,
          }}
        />
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

const styles: Record<string, React.CSSProperties> = {
  root: {
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
  chartCanvas: {
    flex: 1,
    minHeight: 160,
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
  lab: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--qb-main-meta, #a1a1aa)" },
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
  meta: { padding: "4px 16px 8px", fontSize: 12, color: "var(--qb-main-meta, #71717a)" },
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
    borderColor: "color-mix(in srgb, var(--qb-warning, #f59e0b) 45%, transparent)",
    background: "color-mix(in srgb, var(--qb-warning, #f59e0b) 9%, transparent)",
  },
  sourceDown: {
    borderColor: "color-mix(in srgb, var(--qb-danger, #ef4444) 45%, transparent)",
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
  metaCompact: { fontSize: 11, color: "var(--qb-main-meta, #71717a)", flex: 1, minWidth: 0 },
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
};
