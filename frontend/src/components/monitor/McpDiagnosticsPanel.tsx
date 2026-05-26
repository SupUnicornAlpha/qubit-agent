/**
 * 单一 MCP server 排障详情面板（右侧）。
 *
 * 与 ToolDiagnosticsPanel 同思路，但额外展示：
 *   - 持久化熔断状态（circuit_state / openedAt / lastErrorMessage / cooldown）
 *   - byTool 表：该 server 下每个 mcp tool 的失败分布
 *
 * MCP 没有沙箱阻断的精确关联（mcp 走的是 dispatcher 层 sandbox 校验，
 * 与 connector 层 sandbox_violation_log 不同），所以这里只显示 sandboxBlockedCount KPI。
 */
import type { FC } from "react";
import { useEffect, useState } from "react";
import {
  getMonitorMcpDiagnostics,
  type MonitorMcpDiagnostics,
} from "../../api/backend";
import { Kpi, styles } from "./monitor-shared";

export type McpDiagnosticsPanelProps = {
  serverName: string;
  windowMinutes: number;
  sessionId?: string;
  onJumpToWorkflow?: (workflowRunId: string) => void;
  autoRefreshMs?: number;
};

export const McpDiagnosticsPanel: FC<McpDiagnosticsPanelProps> = ({
  serverName,
  windowMinutes,
  sessionId,
  onJumpToWorkflow,
  autoRefreshMs = 30_000,
}) => {
  const [data, setData] = useState<MonitorMcpDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    const fetch = async () => {
      setLoading(true);
      try {
        const params: Parameters<typeof getMonitorMcpDiagnostics>[0] = {
          serverName,
          windowMinutes,
          recentLimit: 50,
          errorTopLimit: 10,
        };
        if (sessionId) params.sessionId = sessionId;
        const r = await getMonitorMcpDiagnostics(params);
        if (!aborted) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (!aborted) setError(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (!aborted) setLoading(false);
      }
    };
    void fetch();
    const t = window.setInterval(() => void fetch(), autoRefreshMs);
    return () => {
      aborted = true;
      window.clearInterval(t);
    };
  }, [serverName, windowMinutes, sessionId, autoRefreshMs]);

  if (error) return <div style={{ ...styles.empty, color: "#ef4444" }}>详情加载失败：{error}</div>;
  if (!data && loading) return <div style={styles.empty}>加载中…</div>;
  if (!data) return <div style={styles.empty}>暂无数据</div>;

  const { summary, latency, errorTop, byTool, recentCalls, health } = data;
  const successRatePct = (summary.successRate * 100).toFixed(1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {health ? <HealthBanner health={health} /> : null}

      <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
        <Kpi label="调用数" value={String(summary.totalCalls)} />
        <Kpi
          label="成功率"
          value={`${successRatePct}%`}
          accent={
            summary.successRate >= 0.9
              ? "#22c55e"
              : summary.successRate >= 0.5
                ? "#eab308"
                : "#ef4444"
          }
        />
        <Kpi label="失败" value={String(summary.failedCount)} accent={summary.failedCount > 0 ? "#ef4444" : undefined} />
        <Kpi label="超时" value={String(summary.timeoutCount)} accent={summary.timeoutCount > 0 ? "#eab308" : undefined} />
        <Kpi
          label="沙箱阻断"
          value={String(summary.sandboxBlockedCount)}
          accent={summary.sandboxBlockedCount > 0 ? "#f97316" : undefined}
        />
        <Kpi label="均 latency" value={fmtMs(summary.avgLatencyMs)} />
        <Kpi label="p95" value={fmtMs(latency.p95)} />
        <Kpi label="p99" value={fmtMs(latency.p99)} />
      </div>

      <ErrorTopCard rows={errorTop} />
      <ByToolCard rows={byTool} />
      <RecentCallsTable calls={recentCalls} onJumpToWorkflow={onJumpToWorkflow} />
    </div>
  );
};

// ───────────────────────── 子组件 ─────────────────────────

const HealthBanner: FC<{ health: NonNullable<MonitorMcpDiagnostics["health"]> }> = ({ health }) => {
  const { bg, fg, label } = (() => {
    switch (health.circuitState) {
      case "open":
        return { bg: "rgba(239, 68, 68, 0.12)", fg: "#ef4444", label: "熔断中" };
      case "half_open":
        return { bg: "rgba(234, 179, 8, 0.16)", fg: "#eab308", label: "试探中" };
      default:
        return { bg: "rgba(34, 197, 94, 0.12)", fg: "#22c55e", label: "正常" };
    }
  })();
  return (
    <section
      style={{
        padding: "10px 12px",
        background: bg,
        borderLeft: `3px solid ${fg}`,
        borderRadius: 6,
        fontSize: 12,
        display: "flex",
        gap: 18,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <strong style={{ color: fg, fontSize: 13 }}>熔断状态：{label}</strong>
      {health.circuitState === "open" && health.openedAt ? (
        <span style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>
          开始时间：{new Date(health.openedAt).toLocaleString()}
        </span>
      ) : null}
      <span style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>
        累计失败 <strong style={{ color: fg }}>{health.failureCount}</strong> · 累计成功{" "}
        <strong>{health.successCount}</strong>
      </span>
      <span style={{ color: "var(--qb-main-meta, #a1a1aa)" }}>
        cooldown：{(health.cooldownMs / 1000).toFixed(0)}s
      </span>
      {health.lastErrorMessage ? (
        <details style={{ width: "100%", marginTop: 6 }}>
          <summary style={{ cursor: "pointer", color: fg, fontSize: 11 }}>
            最近错误消息（展开）
          </summary>
          <pre
            style={{
              margin: "6px 0 0",
              fontSize: 11,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "var(--qb-main-input-fg, #e4e4e7)",
            }}
          >
            {health.lastErrorMessage}
          </pre>
        </details>
      ) : null}
    </section>
  );
};

const ErrorTopCard: FC<{ rows: MonitorMcpDiagnostics["errorTop"] }> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <section>
        <h4 style={panelTitle}>错误 Code Top</h4>
        <div style={styles.empty}>窗口内无失败调用</div>
      </section>
    );
  }
  return (
    <section>
      <h4 style={panelTitle}>错误 Code Top（按 errorCode 聚合）</h4>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 50 }}>次数</th>
              <th style={{ ...styles.th, width: 180 }}>错误 Code</th>
              <th style={styles.th}>样本消息</th>
              <th style={{ ...styles.th, width: 160 }}>最近一次</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.errorCode}>
                <td style={{ ...styles.td, fontWeight: 600, color: "#ef4444" }}>{r.count}</td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                  {r.errorCode}
                </td>
                <td
                  style={{ ...styles.td, fontFamily: "monospace", fontSize: 10, maxWidth: 480 }}
                  title={r.sampleMessage ?? ""}
                >
                  {truncate(r.sampleMessage, 100)}
                </td>
                <td style={styles.td}>{new Date(r.lastSeenAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const ByToolCard: FC<{ rows: MonitorMcpDiagnostics["byTool"] }> = ({ rows }) => {
  if (rows.length === 0) return null;
  return (
    <section>
      <h4 style={panelTitle}>该 server 下各 tool 的失败分布</h4>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Tool</th>
              <th style={{ ...styles.th, width: 60 }}>调用</th>
              <th style={{ ...styles.th, width: 60 }}>成功</th>
              <th style={{ ...styles.th, width: 60 }}>失败</th>
              <th style={{ ...styles.th, width: 60 }}>超时</th>
              <th style={{ ...styles.th, width: 80 }}>沙箱</th>
              <th style={{ ...styles.th, width: 90 }}>均 latency</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.toolName}>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                  {r.toolName}
                </td>
                <td style={styles.td}>{r.totalCalls}</td>
                <td style={{ ...styles.td, color: "#22c55e" }}>{r.successCount}</td>
                <td style={{ ...styles.td, color: r.failedCount > 0 ? "#ef4444" : undefined }}>
                  {r.failedCount}
                </td>
                <td style={{ ...styles.td, color: r.timeoutCount > 0 ? "#eab308" : undefined }}>
                  {r.timeoutCount}
                </td>
                <td
                  style={{ ...styles.td, color: r.sandboxBlockedCount > 0 ? "#f97316" : undefined }}
                >
                  {r.sandboxBlockedCount}
                </td>
                <td style={styles.td}>{fmtMs(r.avgLatencyMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

const RecentCallsTable: FC<{
  calls: MonitorMcpDiagnostics["recentCalls"];
  onJumpToWorkflow?: (workflowRunId: string) => void;
}> = ({ calls, onJumpToWorkflow }) => {
  return (
    <section>
      <h4 style={panelTitle}>最近调用流水（最近 50 条，倒序）</h4>
      <div style={{ ...styles.tableWrap, maxHeight: 380 }}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 130 }}>时间</th>
              <th style={styles.th}>Tool</th>
              <th style={{ ...styles.th, width: 110 }}>状态</th>
              <th style={{ ...styles.th, width: 70 }}>重试</th>
              <th style={{ ...styles.th, width: 80 }}>latency</th>
              <th style={styles.th}>错误 Code</th>
              <th style={{ ...styles.th, width: 100 }}>workflow</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td style={{ ...styles.td, fontSize: 11 }}>
                  {new Date(c.createdAt).toLocaleString()}
                </td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                  {c.toolName}
                </td>
                <td style={styles.td}>
                  <StatusTag status={c.status} />
                </td>
                <td style={{ ...styles.td, color: c.retryCount > 0 ? "#eab308" : undefined }}>
                  {c.retryCount}
                </td>
                <td style={styles.td}>{fmtMs(c.latencyMs)}</td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 10 }}>
                  {c.errorCode ?? "—"}
                </td>
                <td style={styles.td}>
                  <button
                    type="button"
                    className="qb-btn-link"
                    onClick={() => onJumpToWorkflow?.(c.workflowRunId)}
                    style={{ fontFamily: "monospace", fontSize: 10 }}
                  >
                    {c.workflowRunId.slice(0, 8)}…
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {calls.length === 0 ? <div style={styles.empty}>窗口内无调用</div> : null}
      </div>
    </section>
  );
};

const StatusTag: FC<{ status: MonitorMcpDiagnostics["recentCalls"][number]["status"] }> = ({
  status,
}) => {
  const { bg, fg, label } = (() => {
    switch (status) {
      case "success":
        return { bg: "rgba(34, 197, 94, 0.16)", fg: "#22c55e", label: "成功" };
      case "timeout":
        return { bg: "rgba(234, 179, 8, 0.16)", fg: "#eab308", label: "timeout" };
      case "sandbox_blocked":
        return { bg: "rgba(249, 115, 22, 0.18)", fg: "#f97316", label: "沙箱" };
      case "failed":
      default:
        return { bg: "rgba(239, 68, 68, 0.16)", fg: "#ef4444", label: "失败" };
    }
  })();
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 6px",
        background: bg,
        color: fg,
        borderRadius: 4,
        fontSize: 10,
        fontWeight: 600,
      }}
    >
      {label}
    </span>
  );
};

const panelTitle: React.CSSProperties = {
  fontSize: 13,
  margin: "6px 0",
  color: "var(--qb-monitor-title-fg, inherit)",
  fontWeight: 600,
};

function fmtMs(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

function truncate(s: string | null, max: number): string {
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
