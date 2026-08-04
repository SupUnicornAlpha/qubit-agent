/**
 * 轻量单标的 K 线卡片：自持 chart 实例与数据，不读写全局 chartSpec。
 * 用于研究画布多标的网格。
 */
import type { CSSProperties, FC } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { getKlines } from "../../api/backend";
import { barsToCandles, barsToVolume, normalizeKlineBars } from "../../lib/klineSeries";

export type MiniKlineCardProps = {
  symbol: string;
  exchange: string;
  timeframe: string;
  limit: number;
  /** 重载令牌；变化时重新拉数 */
  reloadNonce?: number;
  active?: boolean;
  onSelect?: () => void;
  sourceLabel?: string;
  height?: number;
};

export const MiniKlineCard: FC<MiniKlineCardProps> = ({
  symbol,
  exchange,
  timeframe,
  limit,
  reloadNonce = 0,
  active = false,
  onSelect,
  sourceLabel,
  height = 220,
}) => {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [barCount, setBarCount] = useState(0);
  const [lastClose, setLastClose] = useState<number | null>(null);

  const layout = useCallback(() => {
    const el = wrapRef.current;
    const chart = chartRef.current;
    if (!el || !chart) return;
    chart.applyOptions({
      width: el.clientWidth,
      height: Math.max(120, el.clientHeight),
    });
    chart.timeScale().fitContent();
  }, []);

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
      rightPriceScale: { borderColor: "#3f3f46" },
      timeScale: { borderColor: "#3f3f46", timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
      width: el.clientWidth,
      height: Math.max(120, el.clientHeight),
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
    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;

    const ro = new ResizeObserver(() => layout());
    ro.observe(el);
    layout();
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, [layout]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const sym = symbol.trim();
      if (!sym) {
        setError("无标的");
        candleRef.current?.setData([]);
        volRef.current?.setData([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await getKlines({
          symbol: sym,
          exchange: exchange.trim() || undefined,
          timeframe,
          limit,
        });
        if (cancelled) return;
        if (!res.ok || !Array.isArray(res.data)) {
          setError("加载失败");
          candleRef.current?.setData([]);
          volRef.current?.setData([]);
          setBarCount(0);
          setLastClose(null);
          return;
        }
        const bars = normalizeKlineBars(res.data, timeframe, limit);
        candleRef.current?.setData(barsToCandles(bars, timeframe));
        volRef.current?.setData(barsToVolume(bars, timeframe));
        setBarCount(bars.length);
        setLastClose(bars.length ? bars[bars.length - 1]!.close : null);
        layout();
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setBarCount(0);
          setLastClose(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, timeframe, limit, reloadNonce, layout]);

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        ...styles.card,
        ...(active ? styles.cardActive : null),
        height,
      }}
      title={`切换焦点到 ${symbol}.${exchange}`}
    >
      <div style={styles.head}>
        <span style={styles.sym}>
          {symbol}
          <span style={styles.ex}>.{exchange}</span>
        </span>
        <span style={styles.meta}>
          {sourceLabel ? `${sourceLabel} · ` : ""}
          {timeframe}
          {lastClose != null ? ` · ${lastClose.toFixed(2)}` : ""}
          {loading ? " · 加载中…" : ""}
        </span>
      </div>
      <div ref={wrapRef} style={styles.chart} />
      {error ? <div style={styles.error}>{error}</div> : null}
      {!error && !loading && barCount === 0 ? (
        <div style={styles.empty}>暂无 K 线数据</div>
      ) : null}
    </button>
  );
};

const styles: Record<string, CSSProperties> = {
  card: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    border: "1px solid #2a2a30",
    borderRadius: 10,
    background: "rgba(8,8,10,0.92)",
    overflow: "hidden",
    cursor: "pointer",
    textAlign: "left",
    padding: 0,
    fontFamily: "inherit",
    color: "inherit",
  },
  cardActive: {
    borderColor: "rgba(56,189,248,0.65)",
    boxShadow: "0 0 0 1px rgba(56,189,248,0.25)",
  },
  head: {
    flexShrink: 0,
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 10px 4px",
  },
  sym: {
    fontSize: 13,
    fontWeight: 700,
    color: "#e4e4e7",
  },
  ex: {
    fontSize: 11,
    fontWeight: 500,
    color: "#64748b",
    marginLeft: 2,
  },
  meta: {
    fontSize: 10.5,
    color: "#71717a",
  },
  chart: {
    flex: 1,
    minHeight: 0,
    width: "100%",
  },
  error: {
    flexShrink: 0,
    padding: "4px 10px 8px",
    fontSize: 11,
    color: "#fca5a5",
  },
  empty: {
    flexShrink: 0,
    padding: "4px 10px 8px",
    fontSize: 11,
    color: "#71717a",
  },
};
