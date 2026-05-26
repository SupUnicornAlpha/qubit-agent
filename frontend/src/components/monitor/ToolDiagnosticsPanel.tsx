/**
 * 单一 Tool 排障详情面板（右侧）。
 *
 * 由 DiagnosticsTab 在左侧表选中行后渲染。负责拉 `/api/v1/monitor/tools/:name/detail`
 * 并把结果展示为四块：KPI / 错误 Top / 沙箱阻断分类 / 最近调用流水。
 *
 * 关闭右侧面板时通过 prop 传 null toolName 控制；不在面板内自管开关，由父组件统一驱动。
 */
import type { FC } from "react";
import { useEffect, useState } from "react";
import {
  getMonitorToolDiagnostics,
  type MonitorToolDiagnostics,
  type MonitorToolKind,
} from "../../api/backend";
import { Kpi, styles } from "./monitor-shared";

export type ToolDiagnosticsPanelProps = {
  toolName: string;
  toolKind?: MonitorToolKind;
  windowMinutes: number;
  sessionId?: string;
  /** 当用户在最近调用流水中点击 workflow → 父组件处理跳转 */
  onJumpToWorkflow?: (workflowRunId: string) => void;
  /** 30s 自动刷新（默认 30000） */
  autoRefreshMs?: number;
};

export const ToolDiagnosticsPanel: FC<ToolDiagnosticsPanelProps> = ({
  toolName,
  toolKind,
  windowMinutes,
  sessionId,
  onJumpToWorkflow,
  autoRefreshMs = 30_000,
}) => {
  const [data, setData] = useState<MonitorToolDiagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let aborted = false;
    const fetch = async () => {
      setLoading(true);
      try {
        const params: Parameters<typeof getMonitorToolDiagnostics>[0] = {
          toolName,
          windowMinutes,
          recentLimit: 50,
          errorTopLimit: 10,
        };
        if (toolKind) params.toolKind = toolKind;
        if (sessionId) params.sessionId = sessionId;
        const r = await getMonitorToolDiagnostics(params);
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
  }, [toolName, toolKind, windowMinutes, sessionId, autoRefreshMs]);

  if (error) return <div style={{ ...styles.empty, color: "#ef4444" }}>详情加载失败：{error}</div>;
  if (!data && loading) return <div style={styles.empty}>加载中…</div>;
  if (!data) return <div style={styles.empty}>暂无数据</div>;

  const { summary, latency, errorTop, sandboxViolations, recentCalls } = data;
  const successRatePct = (summary.successRate * 100).toFixed(1);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="qb-monitor__kpi-row" style={styles.kpiRow}>
        <Kpi label="调用数" value={String(summary.totalCalls)} />
        <Kpi
          label="成功率"
          value={`${successRatePct}%`}
          accent={summary.successRate >= 0.9 ? "#22c55e" : summary.successRate >= 0.5 ? "#eab308" : "#ef4444"}
        />
        <Kpi label="失败" value={String(summary.errorCount)} accent={summary.errorCount > 0 ? "#ef4444" : undefined} />
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

      {sandboxViolations.length > 0 ? <SandboxViolationsCard rows={sandboxViolations} /> : null}

      <RecentCallsTable calls={recentCalls} onJumpToWorkflow={onJumpToWorkflow} />
    </div>
  );
};

// ───────────────────────── 子组件 ─────────────────────────

const ErrorTopCard: FC<{ rows: MonitorToolDiagnostics["errorTop"] }> = ({ rows }) => {
  if (rows.length === 0) {
    return (
      <section>
        <h4 style={panelTitle}>错误原因 Top</h4>
        <div style={styles.empty}>窗口内无失败调用</div>
      </section>
    );
  }
  return (
    <section>
      <h4 style={panelTitle}>错误原因 Top（按出现次数）</h4>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 50 }}>次数</th>
              <th style={styles.th}>错误消息（已 mask UUID/时间戳）</th>
              <th style={{ ...styles.th, width: 160 }}>最近一次</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.errorMessage}>
                <td style={{ ...styles.td, fontWeight: 600, color: "#ef4444" }}>{r.count}</td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11, maxWidth: 600 }}>
                  {r.errorMessage}
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

const SandboxViolationsCard: FC<{ rows: MonitorToolDiagnostics["sandboxViolations"] }> = ({ rows }) => {
  return (
    <section>
      <h4 style={{ ...panelTitle, color: "#f97316" }}>沙箱阻断分类（看为何被沙箱拒绝）</h4>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: 200 }}>违规类型</th>
              <th style={{ ...styles.th, width: 60 }}>次数</th>
              <th style={{ ...styles.th, width: 160 }}>最近一次</th>
              <th style={styles.th}>策略 ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.violationType}>
                <td style={{ ...styles.td, fontWeight: 600 }}>{r.violationType}</td>
                <td style={{ ...styles.td, color: "#f97316" }}>{r.count}</td>
                <td style={styles.td}>{new Date(r.lastSeenAt).toLocaleString()}</td>
                <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 10 }} title={r.samplePolicyId ?? ""}>
                  {r.samplePolicyId ? `${r.samplePolicyId.slice(0, 8)}…` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ ...styles.empty, padding: "6px 4px", fontSize: 11 }}>
        提示：违规类型解释 — `tool_not_allowed` 表示沙箱白名单未授权该工具；`network_blocked`
        表示工具试图访问被禁的域名/IP；`fs_blocked` 表示文件系统越界。
      </div>
    </section>
  );
};

const RecentCallsTable: FC<{
  calls: MonitorToolDiagnostics["recentCalls"];
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
              <th style={{ ...styles.th, width: 110 }}>状态</th>
              <th style={{ ...styles.th, width: 60 }}>step</th>
              <th style={{ ...styles.th, width: 70 }}>重试</th>
              <th style={{ ...styles.th, width: 80 }}>latency</th>
              <th style={styles.th}>错误消息</th>
              <th style={{ ...styles.th, width: 100 }}>workflow</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((c) => (
              <tr key={c.id}>
                <td style={{ ...styles.td, fontSize: 11 }}>{new Date(c.createdAt).toLocaleString()}</td>
                <td style={styles.td}>
                  <StatusTag status={c.status} />
                </td>
                <td style={styles.td}>{c.stepIndex ?? "—"}</td>
                <td style={{ ...styles.td, color: c.retryCount > 0 ? "#eab308" : undefined }}>
                  {c.retryCount}
                </td>
                <td style={styles.td}>{fmtMs(c.latencyMs)}</td>
                <td
                  style={{ ...styles.td, fontFamily: "monospace", fontSize: 10, maxWidth: 380 }}
                  title={c.errorMessage ?? ""}
                >
                  {truncate(c.errorMessage, 80)}
                </td>
                <td style={styles.td}>
                  {c.workflowRunId ? (
                    <button
                      type="button"
                      className="qb-btn-link"
                      onClick={() => c.workflowRunId && onJumpToWorkflow?.(c.workflowRunId)}
                      style={{ fontFamily: "monospace", fontSize: 10 }}
                    >
                      {c.workflowRunId.slice(0, 8)}…
                    </button>
                  ) : (
                    "—"
                  )}
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

const StatusTag: FC<{ status: MonitorToolDiagnostics["recentCalls"][number]["status"] }> = ({ status }) => {
  const { bg, fg, label } = (() => {
    switch (status) {
      case "success":
        return { bg: "rgba(34, 197, 94, 0.16)", fg: "#22c55e", label: "成功" };
      case "timeout":
        return { bg: "rgba(234, 179, 8, 0.16)", fg: "#eab308", label: "timeout" };
      case "sandbox_blocked":
        return { bg: "rgba(249, 115, 22, 0.18)", fg: "#f97316", label: "沙箱阻断" };
      case "error":
      default:
        return { bg: "rgba(239, 68, 68, 0.16)", fg: "#ef4444", label: "错误" };
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
