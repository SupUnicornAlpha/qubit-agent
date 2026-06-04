/**
 * 监控 V3 P0 — 通用 timeseries 图表组件（Grafana-lite 的基本积木）。
 *
 * 责任分工：
 *   - **拉数据**：自带 polling + 时间窗口选择，调用 `/api/v1/monitor/timeseries`
 *   - **画图**：用项目内已装的 recharts；不引入新依赖
 *   - **不**承载 KPI / 表格等附加内容；那些由各 Tab 自己组装
 *
 * 数据契约：`MonitorTimeseriesResult`（详见 frontend/src/api/backend.ts）
 *   - `buckets: ISO[]` 与 `series[].points: number[]` 严格一一对应
 *   - 缺数据桶补 0；series 名称按字典序稳定
 *
 * 时间窗口：本组件不接受"绝对 from/to"——它根据 `defaultWindowMinutes` 把窗口对齐到现在；
 *   外部需要"自定义区间"应在父组件改造，这次只先做"近 N 时间"快捷视图（够 Grafana-lite）。
 *
 * 留给后续：
 *   - rangeSelector：滑动选择子区间
 *   - 同步 hover：跨多个 chart 联动指针
 *   - 点击点跳转：dataKey + onClick payload 已经具备；先不暴露
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FC } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  getMonitorTimeseries,
  type MonitorTimeseriesGroupBy,
  type MonitorTimeseriesInterval,
  type MonitorTimeseriesMetric,
  type MonitorTimeseriesResult,
  type MonitorTimeseriesSource,
} from "../../api/backend";
import {
  CHART_COLORS,
  monitorAxisTick,
  monitorGridStroke,
  monitorTooltipStyle,
  styles,
} from "./monitor-shared";

export type TimeseriesChartProps = {
  title: string;
  source: MonitorTimeseriesSource;
  metric: MonitorTimeseriesMetric;
  /** 缺省 '1h'；用户在 UI 上可切（如果 windowPresets 给的较短，会自动降为 5m/15m） */
  defaultInterval?: MonitorTimeseriesInterval;
  /** 缺省 1440 分钟（24h） */
  defaultWindowMinutes?: number;
  /** 缺省 [60, 360, 1440, 4320]（1h / 6h / 24h / 3d） */
  windowPresets?: number[];
  /** 缺省按时长自适应：≤6h 用 5m；≤24h 用 1h；> 24h 用 1d。可在 props 强制覆盖。 */
  forceInterval?: MonitorTimeseriesInterval;
  groupBy?: MonitorTimeseriesGroupBy;
  sessionId?: string | undefined;
  /** name 自定义映射（如把 definitionId → "ANALYST_NEWS"） */
  seriesNameFormatter?: (rawName: string) => string;
  /** Y 轴单位/格式化（"tokens" / "ms" / "$"），缺省按 metric 推断 */
  yFormat?: (value: number) => string;
  /** 自动刷新（ms），缺省 60s；传 0 关闭 */
  autoRefreshMs?: number;
  /** 图高度，缺省 220 */
  height?: number;
  /** 单 series 不显示 Legend（节省高度），缺省 false */
  hideLegendIfSingleSeries?: boolean;
};

const DEFAULT_WINDOWS = [60, 360, 1440, 4320] as const; // 1h / 6h / 24h / 3d

export const TimeseriesChart: FC<TimeseriesChartProps> = ({
  title,
  source,
  metric,
  defaultInterval,
  defaultWindowMinutes = 1440,
  windowPresets,
  forceInterval,
  groupBy,
  sessionId,
  seriesNameFormatter,
  yFormat,
  autoRefreshMs = 60_000,
  height = 220,
  hideLegendIfSingleSeries = false,
}) => {
  const [windowMinutes, setWindowMinutes] = useState<number>(defaultWindowMinutes);
  const [data, setData] = useState<MonitorTimeseriesResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  /**
   * 桶间隔自适应：
   *   - ≤ 60m  → 1m  （让 1h 视图至少 60 个点）
   *   - ≤ 6h   → 5m
   *   - ≤ 24h  → 1h
   *   - > 24h  → 1d
   *
   * forceInterval / defaultInterval 优先级最高（按顺序）。
   */
  const interval = useMemo<MonitorTimeseriesInterval>(() => {
    if (forceInterval) return forceInterval;
    if (defaultInterval) return defaultInterval;
    if (windowMinutes <= 60) return "1m";
    if (windowMinutes <= 360) return "5m";
    if (windowMinutes <= 1440) return "1h";
    return "1d";
  }, [forceInterval, defaultInterval, windowMinutes]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - windowMinutes * 60_000);
      const params: Parameters<typeof getMonitorTimeseries>[0] = {
        source,
        metric,
        interval,
        from: from.toISOString(),
        to: to.toISOString(),
      };
      if (groupBy) params.groupBy = groupBy;
      if (sessionId) params.sessionId = sessionId;
      const res = await getMonitorTimeseries(params);
      setData(res);
      setHint(
        res.series.length === 0 || res.series.every((s) => s.points.every((p) => p === 0))
          ? "窗口内无数据"
          : null
      );
    } catch (e) {
      setHint(e instanceof Error ? e.message : "加载失败");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [source, metric, interval, windowMinutes, groupBy, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = window.setInterval(() => void refresh(), autoRefreshMs);
    return () => window.clearInterval(t);
  }, [refresh, autoRefreshMs]);

  /**
   * recharts 要求 data 是 [{ ts, seriesA: 3, seriesB: 5 }, ...]，
   * 与后端的"列存"输出（series[].points[]）相反，前端在这里转置。
   */
  const rechartsData = useMemo(() => {
    if (!data) return [];
    return data.buckets.map((ts, i) => {
      const row: Record<string, string | number> = { ts: formatTsLabel(ts, data.interval) };
      for (const s of data.series) {
        const displayName = seriesNameFormatter ? seriesNameFormatter(s.name) : s.name;
        row[displayName] = s.points[i] ?? 0;
      }
      return row;
    });
  }, [data, seriesNameFormatter]);

  const seriesNames = useMemo(
    () =>
      (data?.series ?? []).map((s) =>
        seriesNameFormatter ? seriesNameFormatter(s.name) : s.name
      ),
    [data, seriesNameFormatter]
  );

  const presets = windowPresets ?? [...DEFAULT_WINDOWS];

  const effectiveYFormat = yFormat ?? makeDefaultFormatter(metric);

  return (
    <div className="qb-monitor__panel qb-a3d-tilt" style={styles.chartBox}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <div style={styles.chartTitle}>
          {title}
          <span
            style={{
              marginLeft: 8,
              fontSize: 10,
              color: "var(--qb-main-meta, #94a3b8)",
              fontWeight: 400,
            }}
          >
            · 桶 {interval}
            {groupBy ? ` · 按 ${groupBy} 切分` : ""}
          </span>
        </div>
        <div style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <select
            style={{ ...styles.select, fontSize: 11, padding: "2px 6px" }}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
            aria-label={`${title} 时间窗口`}
          >
            {presets.map((m) => (
              <option key={m} value={m}>
                近 {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="qb-btn-secondary"
            style={{ fontSize: 11, padding: "2px 8px" }}
            onClick={() => void refresh()}
            disabled={loading}
            title="刷新"
          >
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={rechartsData} margin={{ top: 8, right: 10, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={monitorGridStroke} />
          <XAxis
            dataKey="ts"
            tick={{ ...monitorAxisTick, fontSize: 10 }}
            minTickGap={24}
          />
          <YAxis
            tick={{ ...monitorAxisTick, fontSize: 10 }}
            tickFormatter={effectiveYFormat}
            width={50}
          />
          <Tooltip
            contentStyle={monitorTooltipStyle}
            formatter={(v: number) => effectiveYFormat(v)}
          />
          {!(hideLegendIfSingleSeries && seriesNames.length <= 1) ? <Legend /> : null}
          {seriesNames.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              stroke={CHART_COLORS[i % CHART_COLORS.length]}
              strokeWidth={1.8}
              dot={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {hint ? (
        <div style={{ ...styles.hint, marginTop: 4 }}>{hint}</div>
      ) : null}
    </div>
  );
};

// ───────────────────────── 内部工具 ─────────────────────────

/**
 * 把 ISO 桶时间戳格式化成 X 轴标签：
 *   - 1m/5m/15m → HH:mm
 *   - 1h        → MM-DD HH:00 / 单日内只显示 HH:00
 *   - 1d        → MM-DD
 *
 * 不直接展示 ISO，否则 X 轴密密麻麻看不清。
 */
function formatTsLabel(iso: string, interval: MonitorTimeseriesInterval): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const HH = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const MM = String(d.getMonth() + 1).padStart(2, "0");
  const DD = String(d.getDate()).padStart(2, "0");
  if (interval === "1d") return `${MM}-${DD}`;
  if (interval === "1h") return `${MM}-${DD} ${HH}:00`;
  return `${HH}:${mm}`;
}

function makeDefaultFormatter(
  metric: MonitorTimeseriesMetric
): (value: number) => string {
  return (v: number) => {
    if (!Number.isFinite(v)) return "—";
    switch (metric) {
      case "cost":
        return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
      case "tokens":
        return shortNumber(v);
      case "avgLatency":
        return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;
      default:
        return shortNumber(v);
    }
  };
}

function shortNumber(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(2)}k`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}
