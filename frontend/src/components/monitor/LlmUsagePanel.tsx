/**
 * LLM 用量面板（监控 V2 P1）。
 *
 * 设计参考 docs/MONITORING_V2_DESIGN.md §4.1.1 / §5.2 / §7.5。
 * 嵌入 OverviewTab；自带 polling，不依赖父组件。
 *
 * 内容（按上→下）：
 *   1) KPI 三件套：24h 总调用数 / 总 token / 总 cost (USD)
 *   2) 按 provider:model 的表格（调用量、成功率、平均 latency、cost）
 *   3) 错误 top 列表（窗口内异常消息聚合，便于一眼看见 quota / network 类问题）
 */
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getMonitorLlmUsage,
  type MonitorLlmUsageGroup,
  type MonitorLlmUsageSummary,
} from "../../api/backend";
import { Kpi, styles } from "./monitor-shared";

export type LlmUsagePanelProps = {
  /** session 过滤；不传 = 全部 session */
  sessionId?: string | undefined;
  /** 默认窗口（分钟），缺省 1440=24h */
  defaultWindowMinutes?: number;
  /** 自动刷新间隔，缺省 60s；传 0 关闭 */
  autoRefreshMs?: number;
};

const WINDOW_PRESETS = [60, 240, 1440, 4320] as const;

export const LlmUsagePanel: FC<LlmUsagePanelProps> = ({
  sessionId,
  defaultWindowMinutes = 1440,
  autoRefreshMs = 60_000,
}) => {
  const [windowMinutes, setWindowMinutes] = useState<number>(defaultWindowMinutes);
  const [data, setData] = useState<MonitorLlmUsageSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const params: Parameters<typeof getMonitorLlmUsage>[0] = { windowMinutes };
      if (sessionId) params.sessionId = sessionId;
      const res = await getMonitorLlmUsage(params);
      setData(res);
      setHint(res.totals.totalCalls === 0 ? "窗口内无 LLM 调用" : null);
    } catch (e) {
      setHint(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [windowMinutes, sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefreshMs || autoRefreshMs <= 0) return;
    const t = window.setInterval(() => {
      void refresh();
    }, autoRefreshMs);
    return () => window.clearInterval(t);
  }, [refresh, autoRefreshMs]);

  const totals = data?.totals;
  const kpiTokens = useMemo(() => {
    if (!totals) return "—";
    return formatNumber(totals.totalTokens);
  }, [totals]);
  const kpiCost = useMemo(() => {
    if (!totals) return "—";
    return `$${totals.costUsd.toFixed(4)}`;
  }, [totals]);
  const kpiCalls = useMemo(() => {
    if (!totals) return "—";
    return `${totals.totalCalls}`;
  }, [totals]);
  const kpiSuccessRate = useMemo(() => {
    if (!totals) return "—";
    return totals.totalCalls === 0 ? "—" : `${(totals.successRate * 100).toFixed(1)}%`;
  }, [totals]);

  return (
    <section className="qb-monitor__panel qb-a3d-tilt" style={panelStyle}>
      <header style={headerStyle}>
        <div style={titleStyle}>LLM 用量</div>
        <div style={styles.form}>
          <select
            style={styles.select}
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
            aria-label="LLM 时间窗口"
          >
            {WINDOW_PRESETS.map((m) => (
              <option key={m} value={m}>
                近 {m < 60 ? `${m}m` : m < 1440 ? `${m / 60}h` : `${m / 1440}d`}
              </option>
            ))}
          </select>
          <button
            className="qb-btn-secondary"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? "加载中…" : "刷新"}
          </button>
        </div>
      </header>

      <div style={kpiRowStyle}>
        <Kpi label="调用数" value={kpiCalls} />
        <Kpi label="总 token" value={kpiTokens} />
        <Kpi label="估算 cost" value={kpiCost} accent="#22c55e" />
        <Kpi label="成功率" value={kpiSuccessRate} />
      </div>

      {hint ? <div style={styles.hint}>{hint}</div> : null}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Provider</th>
              <th style={styles.th}>Model</th>
              <th style={styles.th}>调用</th>
              <th style={styles.th}>成功率</th>
              <th style={styles.th}>Prompt</th>
              <th style={styles.th}>Completion</th>
              <th style={styles.th}>Total</th>
              <th style={styles.th}>Cost ($)</th>
              <th style={styles.th}>P50 latency (ms)</th>
            </tr>
          </thead>
          <tbody>
            {(data?.byProviderModel ?? []).map((row) => (
              <tr key={`${row.provider}:${row.model}`} style={styles.tr}>
                <td style={styles.td}>{row.provider}</td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                  {row.model}
                </td>
                <td style={styles.td}>{row.totalCalls}</td>
                <td style={styles.td}>{formatRate(row.successRate)}</td>
                <td style={styles.td}>{formatNumber(row.promptTokens)}</td>
                <td style={styles.td}>{formatNumber(row.completionTokens)}</td>
                <td style={styles.td}>{formatNumber(row.totalTokens)}</td>
                <td style={styles.td}>${row.costUsd.toFixed(4)}</td>
                <td style={styles.td}>
                  {row.avgLatencyMs != null ? Math.round(row.avgLatencyMs) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && data.errorTopN.length > 0 ? <ErrorTopN rows={data.errorTopN} /> : null}
    </section>
  );
};

const ErrorTopN: FC<{ rows: MonitorLlmUsageSummary["errorTopN"] }> = ({ rows }) => (
  <div style={{ marginTop: 12 }}>
    <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 6 }}>错误 Top {rows.length}</div>
    <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12, color: "#fda4af" }}>
      {rows.map((r, idx) => (
        <li key={idx} style={{ marginBottom: 4 }}>
          <span style={{ color: "#fca5a5", fontVariantNumeric: "tabular-nums" }}>
            ×{r.count}
          </span>{" "}
          <span title={r.message}>{truncate(r.message, 160)}</span>
        </li>
      ))}
    </ul>
  </div>
);

function _isGroup(_v: MonitorLlmUsageGroup): _v is MonitorLlmUsageGroup {
  return true;
}
void _isGroup;

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(2)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const panelStyle: React.CSSProperties = {
  padding: 12,
  borderRadius: 12,
  background: "rgba(15,23,42,0.45)",
  border: "1px solid rgba(148,163,184,0.18)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "#e2e8f0",
};

const kpiRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 8,
};
