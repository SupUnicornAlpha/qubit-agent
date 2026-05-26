/**
 * Agent 下钻详情面板：byTool / byMcp / bySkill / errorTopN + 最近失败实例。
 *
 * 设计见 docs/MONITORING_V2_DESIGN.md §4.1.3 / §5.3：「点击 Agent 卡片」就近展开本面板，
 * 不开 drawer / 不切路由（与 user 拍板的方案一致）。
 *
 * Props：
 *   - definitionId / role / name：上层选中 Agent 的信息（避免详情未加载时空白）
 *   - onJumpToWorkflow：失败实例行点击 → 跳到 workflow tab 并选中
 */
import type { FC } from "react";
import { useEffect, useState } from "react";
import { getAgentRuntimeDetail, type AgentRuntimeDetail } from "../../api/backend";
import { styles } from "./monitor-shared";

export type AgentDetailDrillDownProps = {
  definitionId: string;
  role: string;
  name?: string | undefined;
  onJumpToWorkflow?: (workflowRunId: string) => void;
  onClose?: () => void;
};

export const AgentDetailDrillDown: FC<AgentDetailDrillDownProps> = ({
  definitionId,
  role,
  name,
  onJumpToWorkflow,
  onClose,
}) => {
  const [detail, setDetail] = useState<AgentRuntimeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getAgentRuntimeDetail(definitionId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId]);

  const m = detail?.metric;
  const b = detail?.breakdown;

  return (
    <section className="qb-monitor__panel qb-a3d-tilt" style={panelStyle} aria-label={`${role} 下钻`}>
      <header style={headerStyle}>
        <div style={titleStyle}>
          <span style={{ marginRight: 8 }}>角色下钻：</span>
          <strong style={{ color: "var(--qb-blue, #93c5fd)" }}>{role}</strong>
          {name && name !== role ? <span style={{ marginLeft: 8, opacity: 0.7 }}>· {name}</span> : null}
        </div>
        {onClose ? (
          <button type="button" className="qb-btn-mini" onClick={onClose} aria-label="关闭下钻">
            收起
          </button>
        ) : null}
      </header>

      {loading ? <div style={styles.hint}>加载中…</div> : null}
      {error ? <div style={{ ...styles.hint, color: "#f87171" }}>{error}</div> : null}
      {!loading && !error && !detail ? <div style={styles.empty}>暂无数据</div> : null}

      {detail && !loading ? (
        <>
          <div className="qb-monitor__kpi-row" style={{ ...styles.kpiRow, marginBottom: 12 }}>
            <Kpi label="窗口运行" value={String(m?.runCount ?? 0)} />
            <Kpi label="成功" value={String(m?.successCount ?? 0)} accent="#22c55e" />
            <Kpi label="错误" value={String(m?.errorCount ?? 0)} accent="#ef4444" />
            <Kpi label="超时" value={String(m?.timeoutCount ?? 0)} accent="#f97316" />
            <Kpi
              label="p50"
              value={m?.p50LatencyMs != null ? `${Math.round(m.p50LatencyMs)}ms` : "—"}
            />
            <Kpi
              label="p95"
              value={m?.p95LatencyMs != null ? `${Math.round(m.p95LatencyMs)}ms` : "—"}
              accent="#a78bfa"
            />
            <Kpi
              label="平均 Token"
              value={m?.avgTokenCount != null ? String(m.avgTokenCount) : "—"}
            />
          </div>

          <div style={twoColStyle}>
            <BreakdownTable
              title="按工具（builtin / acp / skill）"
              rows={toRows(b?.byTool, "errAvg")}
              emptyHint="窗口内未调用工具"
            />
            <BreakdownTable
              title="按 MCP 服务"
              rows={toRows(b?.byMcp, "errAvg")}
              emptyHint="窗口内未调用 MCP"
            />
          </div>
          <div style={twoColStyle}>
            <BreakdownTable
              title="按 Skill 执行"
              rows={toRows(b?.bySkill, "fail")}
              emptyHint="窗口内无 skill 执行"
            />
            <ErrorTopNPanel rows={b?.errorTopN ?? []} />
          </div>

          {detail.failedInstances.length > 0 ? (
            <>
              <h4 style={{ ...styles.poolTitle, marginTop: 12 }}>窗口内失败实例（最近 10）</h4>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>时间</th>
                      <th style={styles.th}>Workflow</th>
                      <th style={styles.th}>错误摘要</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.failedInstances.map((inst) => (
                      <tr
                        key={inst.id}
                        style={styles.tr}
                        onClick={() => onJumpToWorkflow?.(inst.workflowRunId)}
                        title={inst.errorMessage ?? ""}
                      >
                        <td style={{ ...styles.td, whiteSpace: "nowrap" }}>
                          {inst.endedAt ? new Date(inst.endedAt).toLocaleString() : "—"}
                        </td>
                        <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                          {inst.workflowRunId.slice(0, 12)}…
                        </td>
                        <td
                          style={{
                            ...styles.td,
                            maxWidth: 460,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {inst.errorMessage ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
};

// ─────────────────────────── helpers ───────────────────────────

type BreakdownRow = { name: string; count: number; right: string | null };

/**
 * 把 breakdown 子对象（byTool / byMcp / bySkill）整理成统一行格式：
 *   - "errAvg" 形态：右侧列展示「错误 N · 平均 N ms」
 *   - "fail"   形态：右侧列展示「失败 N」（用于 bySkill）
 */
function toRows(
  bucket: Record<string, { count: number; error?: number; fail?: number; avgLatencyMs?: number | null }> | undefined,
  mode: "errAvg" | "fail"
): BreakdownRow[] {
  if (!bucket) return [];
  const rows: BreakdownRow[] = Object.entries(bucket).map(([name, v]) => {
    let right: string | null = null;
    if (mode === "errAvg") {
      const parts: string[] = [];
      if ((v.error ?? 0) > 0) parts.push(`错误 ${v.error}`);
      if (v.avgLatencyMs != null) parts.push(`avg ${Math.round(v.avgLatencyMs)}ms`);
      right = parts.length ? parts.join(" · ") : null;
    } else if (mode === "fail") {
      right = (v.fail ?? 0) > 0 ? `失败 ${v.fail}` : null;
    }
    return { name, count: v.count, right };
  });
  rows.sort((a, b) => b.count - a.count);
  return rows.slice(0, 10);
}

const BreakdownTable: FC<{ title: string; rows: BreakdownRow[]; emptyHint: string }> = ({
  title,
  rows,
  emptyHint,
}) => (
  <div className="qb-monitor__panel" style={subPanelStyle}>
    <div style={styles.chartTitle}>{title}</div>
    {rows.length === 0 ? (
      <div style={styles.empty}>{emptyHint}</div>
    ) : (
      <table style={{ ...styles.table, width: "100%" }}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>{r.name}</td>
              <td style={{ ...styles.td, textAlign: "right", whiteSpace: "nowrap" }}>{r.count}</td>
              <td style={{ ...styles.td, textAlign: "right", color: "var(--qb-main-meta, #71717a)" }}>
                {r.right ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
  </div>
);

const ErrorTopNPanel: FC<{ rows: Array<{ message: string; count: number }> }> = ({ rows }) => (
  <div className="qb-monitor__panel" style={subPanelStyle}>
    <div style={styles.chartTitle}>错误 Top {rows.length || 5}</div>
    {rows.length === 0 ? (
      <div style={styles.empty}>窗口内无失败工具/MCP 调用</div>
    ) : (
      <ul style={{ margin: 0, padding: "8px 12px 4px 24px", fontSize: 12, lineHeight: 1.55 }}>
        {rows.map((r, idx) => (
          <li key={`${idx}-${r.message.slice(0, 24)}`} title={r.message}>
            <span style={{ color: "#f87171", fontWeight: 600, marginRight: 6 }}>×{r.count}</span>
            {r.message.length > 140 ? `${r.message.slice(0, 139)}…` : r.message}
          </li>
        ))}
      </ul>
    )}
  </div>
);

const Kpi: FC<{ label: string; value: string; accent?: string }> = ({ label, value, accent }) => (
  <div
    style={{
      ...styles.kpi,
      borderColor: accent ?? "var(--qb-main-input-border, #3f3f46)",
      flex: "0 0 120px",
    }}
  >
    <div style={styles.kpiLabel}>{label}</div>
    <div style={{ ...styles.kpiValue, color: accent ?? "var(--qb-body-fg, #f4f4f5)", fontSize: 18 }}>
      {value}
    </div>
  </div>
);

const panelStyle = {
  background: "var(--qb-main-card-bg, #111114)",
  border: "1px solid var(--qb-blue, rgba(99, 102, 241, 0.45))",
  borderRadius: 10,
  padding: "12px 14px",
  marginTop: 12,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 8,
};

const titleStyle = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--qb-monitor-title-fg, inherit)",
};

const twoColStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
  gap: 12,
  marginBottom: 12,
};

const subPanelStyle = {
  background: "var(--qb-main-card-bg, #18181b)",
  border: "1px solid var(--qb-main-input-border, #27272a)",
  borderRadius: 8,
  padding: "8px 10px",
};
