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
import { TimeseriesChart } from "./TimeseriesChart";

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
  /** P3-2：cache 命中率 = cachedPromptTokens / promptTokens；用于评估 prompt-caching 效益 */
  const kpiCacheHit = useMemo(() => {
    if (!totals || totals.promptTokens === 0) return "—";
    const rate = totals.cachedPromptTokens / totals.promptTokens;
    return `${(rate * 100).toFixed(1)}%`;
  }, [totals]);
  /** P3-2：reasoning ratio = reasoningTokens / completionTokens；监控推理模型"思考占比" */
  const kpiReasoning = useMemo(() => {
    if (!totals || totals.completionTokens === 0) return "—";
    const rate = totals.reasoningTokens / totals.completionTokens;
    return `${(rate * 100).toFixed(1)}%`;
  }, [totals]);
  /** P3-2：流式 TTFT P95 —— 用户感知的首 token 延迟，比平均 latency 更代表"卡顿体验" */
  const kpiTtftP95 = useMemo(() => {
    if (!totals || totals.p95FirstTokenLatencyMs == null) return "—";
    return `${totals.p95FirstTokenLatencyMs}ms`;
  }, [totals]);
  /** P3-2：被网关 length-retry 自救过的调用占比；高表示 maxOutputTokens 配置偏低 */
  const kpiLengthRetry = useMemo(() => {
    if (!totals || totals.totalCalls === 0) return "—";
    if (totals.lengthRetryCount === 0) return "0";
    return `${totals.lengthRetryCount} (${((totals.lengthRetryCount / totals.totalCalls) * 100).toFixed(1)}%)`;
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
      <div style={kpiRowStyle}>
        <Kpi label="cache 命中率" value={kpiCacheHit} accent="#22d3ee" />
        <Kpi label="reasoning 占比" value={kpiReasoning} accent="#a78bfa" />
        <Kpi label="TTFT P95" value={kpiTtftP95} accent="#f59e0b" />
        <Kpi label="length-retry" value={kpiLengthRetry} accent="#fb7185" />
      </div>
      {data && Object.keys(data.totals.finishReasonBreakdown).length > 0 ? (
        <FinishReasonBars breakdown={data.totals.finishReasonBreakdown} total={data.totals.totalCalls} />
      ) : null}

      {/*
        监控 V3 P0：cost 趋势按 provider 分线。
        和上面 KPI 的"窗口总额"互补——KPI 看大小，时序看分布。
        本图自己拉数据 / 自带刷新；与 KPI 用同一 windowMinutes 字面值默认值即可，
        但两者独立刷新避免互相阻塞。
      */}
      <TimeseriesChart
        title="LLM cost 趋势 / provider"
        source="llm_call_log"
        metric="cost"
        groupBy="provider"
        defaultWindowMinutes={windowMinutes}
        sessionId={sessionId}
        height={200}
      />

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
              <th style={styles.th} title="prompt cache 命中 token / 占总 prompt 的比例">
                Cache 命中
              </th>
              <th style={styles.th} title="reasoning model 链式思考 token / 占 completion 的比例">
                Reasoning
              </th>
              <th style={styles.th}>Cost ($)</th>
              <th style={styles.th}>Avg latency (ms)</th>
              <th style={styles.th} title="流式首 token 到达延迟 P95">TTFT P95</th>
              <th style={styles.th} title="被网关 length-retry 自救的次数">retry</th>
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
                <td style={styles.td}>
                  {formatRatio(row.cachedPromptTokens, row.promptTokens)}
                </td>
                <td style={styles.td}>
                  {formatRatio(row.reasoningTokens, row.completionTokens)}
                </td>
                <td style={styles.td}>${row.costUsd.toFixed(4)}</td>
                <td style={styles.td}>
                  {row.avgLatencyMs != null ? Math.round(row.avgLatencyMs) : "—"}
                </td>
                <td style={styles.td}>
                  {row.p95FirstTokenLatencyMs != null ? `${row.p95FirstTokenLatencyMs}` : "—"}
                </td>
                <td style={{ ...styles.td, color: row.lengthRetryCount > 0 ? "#fb7185" : undefined }}>
                  {row.lengthRetryCount}
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

/** P3-2：把 numerator/denominator 渲染成 "Xk (Y%)" 形式；分母 ≤ 0 → "—"。 */
function formatRatio(numerator: number, denominator: number): string {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return "—";
  }
  if (numerator <= 0) return "0";
  const pct = (numerator / denominator) * 100;
  return `${formatNumber(numerator)} (${pct.toFixed(0)}%)`;
}

/**
 * P3-2：finish reason 频次条形图（横向）。最高条占 100%，其它按比例缩放。
 * 颜色按语义：stop=绿，length/incomplete=橙，content_filter=红，tool_calls=青，其它=灰。
 */
const FINISH_REASON_COLORS: Record<string, string> = {
  stop: "#22c55e",
  end_turn: "#22c55e",
  length: "#f59e0b",
  max_tokens: "#f59e0b",
  max_output_tokens: "#f59e0b",
  incomplete: "#f59e0b",
  content_filter: "#ef4444",
  tool_calls: "#22d3ee",
  tool_use: "#22d3ee",
};

const FinishReasonBars: FC<{ breakdown: Record<string, number>; total: number }> = ({
  breakdown,
  total,
}) => {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0 || total === 0) return null;
  const max = Math.max(...entries.map(([, v]) => v));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 12, color: "#94a3b8" }}>finish reason 分布</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {entries.map(([reason, count]) => {
          const widthPct = max > 0 ? (count / max) * 100 : 0;
          const overall = total > 0 ? ((count / total) * 100).toFixed(1) : "0";
          const color = FINISH_REASON_COLORS[reason] ?? "#94a3b8";
          return (
            <div
              key={reason}
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr 80px",
                gap: 8,
                alignItems: "center",
                fontSize: 11,
              }}
            >
              <span style={{ color: "#cbd5e1", fontFamily: "monospace" }}>{reason}</span>
              <div
                style={{
                  height: 8,
                  borderRadius: 4,
                  background: "rgba(148,163,184,0.15)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${widthPct}%`,
                    height: "100%",
                    background: color,
                    transition: "width 200ms",
                  }}
                />
              </div>
              <span style={{ color: "#94a3b8", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {count} · {overall}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

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
