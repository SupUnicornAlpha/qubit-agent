import type { FC, FormEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { getKlines } from "../../api/backend";
import type { KlineBar, KlinesResponseMeta } from "../../api/types";
import { CHART_MARKET_OPTIONS, CHART_TIMEFRAMES, coerceChartMarketExchange } from "../../lib/chartSpec";
import { useAppStore } from "../../store";
import { NewsBriefSection } from "./NewsBriefSection";

function toChartTime(bar: KlineBar, timeframe: string): Time {
  const tf = timeframe.toLowerCase();
  if (tf === "1d" || tf === "1w") {
    const d = bar.timestamp.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d as Time;
  }
  const sec = Math.floor(new Date(bar.timestamp).getTime() / 1000);
  return sec as UTCTimestamp;
}

function barsToCandles(bars: KlineBar[], timeframe: string): CandlestickData[] {
  const out: CandlestickData[] = [];
  let lastT: number | string | undefined;
  for (const b of bars) {
    const t = toChartTime(b, timeframe);
    const key = typeof t === "number" ? t : String(t);
    if (lastT !== undefined && key === lastT) continue;
    lastT = key as never;
    out.push({
      time: t,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    });
  }
  return out;
}

function barsToVolume(bars: KlineBar[], timeframe: string): HistogramData[] {
  const candles = barsToCandles(bars, timeframe);
  const byTime = new Map<string, KlineBar>();
  for (const b of bars) {
    const t = toChartTime(b, timeframe);
    const key = typeof t === "number" ? String(t) : String(t);
    byTime.set(key, b);
  }
  return candles.map((c) => {
    const key = typeof c.time === "number" ? String(c.time) : String(c.time);
    const b = byTime.get(key);
    const up = b ? b.close >= b.open : c.close >= c.open;
    return {
      time: c.time,
      value: b?.volume ?? 0,
      color: up ? "rgba(38, 166, 154, 0.45)" : "rgba(239, 83, 80, 0.45)",
    };
  });
}

function lineFromSma(bars: KlineBar[], timeframe: string, period: number): LineData[] {
  const candles = barsToCandles(bars, timeframe);
  const out: LineData[] = [];
  for (let i = period - 1; i < bars.length; i++) {
    let s = 0;
    for (let j = 0; j < period; j++) s += bars[i - j].close;
    out.push({ time: candles[i].time, value: s / period });
  }
  return out;
}

function lineFromEma(bars: KlineBar[], timeframe: string, period: number): LineData[] {
  const candles = barsToCandles(bars, timeframe);
  if (bars.length < period) return [];
  let emaVal = 0;
  for (let j = 0; j < period; j++) emaVal += bars[period - 1 - j].close;
  emaVal /= period;
  const k = 2 / (period + 1);
  const out: LineData[] = [{ time: candles[period - 1].time, value: emaVal }];
  for (let i = period; i < bars.length; i++) {
    emaVal = bars[i].close * k + emaVal * (1 - k);
    out.push({ time: candles[i].time, value: emaVal });
  }
  return out;
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
  const activeView = useAppStore((s) => s.activeView);
  const traderMarkers = useAppStore((s) => s.traderMarkers);
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const smaLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const emaLineRef = useRef<ISeriesApi<"Line"> | null>(null);

  const chartOverlays = useAppStore((s) => s.chartOverlays);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<KlinesResponseMeta | null>(null);
  const [lastBars, setLastBars] = useState<KlineBar[]>([]);

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
      layout: {
        background: { type: ColorType.Solid, color: "#0c0c0e" },
        textColor: "#a1a1aa",
      },
      grid: {
        vertLines: { color: "#27272a" },
        horzLines: { color: "#27272a" },
      },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#3f3f46" },
      timeScale: { borderColor: "#3f3f46", timeVisible: true, secondsVisible: false },
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
    smaLineRef.current = smaLine;
    emaLineRef.current = emaLine;

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
    };
  }, [layoutChart, embedded]);

  const load = useCallback(async () => {
    const spec = useAppStore.getState().chartSpec;
    setLoading(true);
    setError(null);
    setLastBars([]);
    try {
      const res = await getKlines({
        symbol: spec.symbol.trim(),
        exchange: spec.exchange.trim() || undefined,
        timeframe: spec.timeframe,
        limit: spec.limit,
      });
      if (!res.ok || !Array.isArray(res.data)) {
        setError("Unexpected response");
        return;
      }
      setMeta(res.meta);
      setLastBars(res.data);
      const c = candleRef.current;
      const v = volRef.current;
      if (c && v) {
        const candles = barsToCandles(res.data, spec.timeframe);
        const vols = barsToVolume(res.data, spec.timeframe);
        c.setData(candles);
        v.setData(vols);
        const { sma20, ema20 } = useAppStore.getState().chartOverlays;
        smaLineRef.current?.setData(
          sma20 && res.data.length >= 20 ? lineFromSma(res.data, spec.timeframe, 20) : []
        );
        emaLineRef.current?.setData(
          ema20 && res.data.length >= 20 ? lineFromEma(res.data, spec.timeframe, 20) : []
        );
        chartRef.current?.timeScale().fitContent();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
    if (lastBars.length === 0) {
      smaLineRef.current?.setData([]);
      emaLineRef.current?.setData([]);
      return;
    }
    const tf = chartSpec.timeframe;
    const { sma20, ema20 } = chartOverlays;
    smaLineRef.current?.setData(sma20 && lastBars.length >= 20 ? lineFromSma(lastBars, tf, 20) : []);
    emaLineRef.current?.setData(ema20 && lastBars.length >= 20 ? lineFromEma(lastBars, tf, 20) : []);
  }, [chartOverlays, lastBars, chartSpec.timeframe]);

  const bringToChat = () => {
    const spec = useAppStore.getState().chartSpec;
    const last = lastBars[lastBars.length - 1];
    const summary = last
      ? `末根 OHLC=${last.open.toFixed(4)}/${last.high.toFixed(4)}/${last.low.toFixed(4)}/${last.close.toFixed(4)} · vol=${Math.round(last.volume)}`
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
    const t = toChartTime(lastBars[lastBars.length - 1], chartSpec.timeframe);
    const markers: SeriesMarker<Time>[] = traderMarkers.map((m) => ({
      id: m.id,
      time: t,
      position: m.side === "buy" ? "belowBar" : "aboveBar",
      shape: m.side === "buy" ? "arrowUp" : "arrowDown",
      color:
        m.source === "agent" ? "#a78bfa" : m.source === "strategy" ? "#38bdf8" : m.side === "buy" ? "#22c55e" : "#f87171",
      text: m.text.length > 24 ? `${m.text.slice(0, 24)}…` : m.text,
    }));
    c.setMarkers(markers);
  }, [linkTraderMarkers, traderMarkers, lastBars, chartSpec.timeframe]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    requestChartReload();
  };

  return (
    <div style={embedded ? styles.root : styles.rootPage}>
      {embedded ? (
        <div style={styles.embeddedBar}>
          {error ? <div style={styles.errCompact}>{error}</div> : null}
          {meta ? (
            <div style={styles.metaCompact}>
              来源 {meta.dataSource} · 返回 {meta.returned}/{meta.requestedLimit}
              {loading ? " · 加载中…" : ""}
            </div>
          ) : loading ? (
            <div style={styles.metaCompact}>加载中…</div>
          ) : null}
          <button
            type="button"
            className="qb-btn-secondary qb-btn--compact"
            disabled={loading || lastBars.length === 0}
            onClick={bringToChat}
          >
            带入对话分析
          </button>
        </div>
      ) : (
        <header style={styles.header}>
          <h1 style={styles.title}>资讯</h1>
          <form style={styles.form} onSubmit={onSubmit}>
            <label style={styles.lab}>
              代码
              <input
                style={styles.inp}
                value={chartSpec.symbol}
                onChange={(e) => setChartSpec({ symbol: e.target.value })}
                placeholder="600000"
              />
            </label>
            <label style={styles.lab}>
              市场
              <select
                style={styles.inp}
                value={coerceChartMarketExchange(chartSpec.exchange)}
                onChange={(e) => setChartSpec({ exchange: e.target.value })}
              >
                {CHART_MARKET_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={styles.lab}>
              周期
              <select
                style={styles.inp}
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
              条数
              <input
                style={styles.inp}
                type="number"
                min={1}
                max={2000}
                value={chartSpec.limit}
                onChange={(e) => setChartSpec({ limit: Number(e.target.value) || 120 })}
              />
            </label>
            <button type="submit" className="qb-btn-primary" disabled={loading}>
              {loading ? "加载中…" : "刷新"}
            </button>
            <button
              type="button"
              className="qb-btn-secondary"
              disabled={loading || lastBars.length === 0}
              onClick={bringToChat}
            >
              带入对话分析
            </button>
          </form>
        </header>
      )}
      {!embedded ? (
        <div style={styles.chartColumn}>
          {error ? <div style={styles.err}>{error}</div> : null}
          {meta ? (
            <div style={styles.meta}>
              来源 {meta.dataSource} · 周期 {meta.timeframe} / {meta.period} · 返回 {meta.returned} / 请求{" "}
              {meta.requestedLimit}
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
    background: "#09090b",
    color: "#e4e4e7",
  },
  rootPage: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    background: "#09090b",
    color: "#e4e4e7",
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
    borderBottom: "1px solid #27272a",
  },
  title: { margin: "0 0 10px", fontSize: 18, fontWeight: 600 },
  form: { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" },
  lab: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#a1a1aa" },
  inp: {
    minWidth: 100,
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid #3f3f46",
    background: "#18181b",
    color: "#e4e4e7",
    fontSize: 13,
  },
  err: { padding: "8px 16px", color: "#fca5a5", fontSize: 13 },
  errCompact: { fontSize: 11, color: "#fca5a5", flex: 1, minWidth: 0 },
  meta: { padding: "4px 16px 8px", fontSize: 12, color: "#71717a" },
  metaCompact: { fontSize: 11, color: "#71717a", flex: 1, minWidth: 0 },
  embeddedBar: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: "6px 12px",
    borderBottom: "1px solid #27272a",
    background: "#111114",
    flexWrap: "wrap",
  },
  chartWrap: { flex: 1, minHeight: 120, width: "100%", position: "relative" },
};
