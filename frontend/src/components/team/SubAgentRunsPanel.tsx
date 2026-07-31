/**
 * 右栏 Orchestrator 对话内的「子 Agent 运行」面板。
 * 折叠态：谁在跑 + 一行活动摘要；展开态：复用 AgentRunPanel 看内部轨迹。
 */
import type { CSSProperties, FC } from "react";
import { useEffect, useState } from "react";
import type { SubAgentRunSummary, SubAgentRunStatus } from "../../lib/subAgentRuns";
import { avatarColorFor, avatarLabelFor, formatRoleName } from "./conversationAvatar";
import { AgentRunPanel } from "./AgentRunChatView";

const STATUS_LABEL: Record<SubAgentRunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  done: "已完成",
  failed: "失败",
};

const STATUS_COLOR: Record<SubAgentRunStatus, string> = {
  queued: "#a1a1aa",
  running: "#38bdf8",
  done: "#4ade80",
  failed: "#f87171",
};

export const SubAgentRunsPanel: FC<{
  runs: SubAgentRunSummary[];
}> = ({ runs }) => {
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (expanded && !runs.some((r) => r.role === expanded)) {
      setExpanded(null);
    }
  }, [runs, expanded]);

  if (runs.length === 0) return null;

  const activeCount = runs.filter((r) => r.status === "running" || r.status === "queued").length;

  return (
    <div style={styles.box} data-qb-subagent-runs>
      <div style={styles.header}>
        <span style={styles.title}>专家进度</span>
        <span style={styles.meta}>
          {activeCount > 0 ? `${activeCount} 个进行中` : `${runs.length} 个已参与`}
        </span>
      </div>
      <div style={styles.list}>
        {runs.map((run) => {
          const open = expanded === run.role;
          const { bg, fg } = avatarColorFor(run.role);
          return (
            <div key={run.role} style={styles.card}>
              <button
                type="button"
                style={styles.summaryBtn}
                aria-expanded={open}
                onClick={() => setExpanded((v) => (v === run.role ? null : run.role))}
              >
                <span
                  aria-hidden
                  style={{
                    ...styles.avatar,
                    background: bg,
                    color: fg,
                  }}
                >
                  {avatarLabelFor(run.role)}
                </span>
                <span style={styles.summaryMain}>
                  <span style={styles.roleRow}>
                    <span style={styles.roleName}>{formatRoleName(run.role)}</span>
                    <span
                      style={{
                        ...styles.statusPill,
                        color: STATUS_COLOR[run.status],
                        borderColor: `${STATUS_COLOR[run.status]}66`,
                      }}
                    >
                      {run.status === "running" ? (
                        <span style={styles.pulse} aria-hidden>
                          ●
                        </span>
                      ) : null}
                      {STATUS_LABEL[run.status]}
                    </span>
                  </span>
                  <span style={styles.headline}>{run.headline}</span>
                  <span style={styles.counts}>
                    {run.stepCount > 0 ? `${run.stepCount} 步` : null}
                    {run.stepCount > 0 && run.toolCount > 0 ? " · " : null}
                    {run.toolCount > 0 ? `${run.toolCount} 次工具` : null}
                    {run.stepCount === 0 && run.toolCount === 0 ? "等待首步…" : null}
                  </span>
                </span>
                <span aria-hidden style={styles.chevron}>
                  {open ? "▾" : "▸"}
                </span>
              </button>
              {open ? (
                <div style={styles.detail}>
                  <AgentRunPanel
                    data={{
                      role: run.role,
                      inbound: run.inbound,
                      outbound: run.outbound,
                      steps: run.steps,
                      tools: run.tools,
                      mcps: run.mcps,
                    }}
                    defaultMode="chat"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  box: {
    border: "1px solid rgba(56,189,248,0.28)",
    borderRadius: 10,
    background: "rgba(14,165,233,0.06)",
    marginBottom: 10,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 10px 6px",
    borderBottom: "1px solid rgba(255,255,255,0.05)",
  },
  title: {
    fontSize: 12,
    fontWeight: 650,
    color: "#e2e8f0",
  },
  meta: {
    fontSize: 11,
    color: "#94a3b8",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
  },
  card: {
    borderTop: "1px solid rgba(255,255,255,0.04)",
  },
  summaryBtn: {
    width: "100%",
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    padding: "8px 10px",
    background: "transparent",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    color: "inherit",
  },
  avatar: {
    flexShrink: 0,
    width: 26,
    height: 26,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    fontWeight: 700,
    marginTop: 1,
  },
  summaryMain: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  roleRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  roleName: {
    fontSize: 12,
    fontWeight: 600,
    color: "#f1f5f9",
  },
  statusPill: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    fontSize: 10,
    padding: "0 6px",
    borderRadius: 999,
    border: "1px solid",
    lineHeight: "16px",
  },
  pulse: {
    fontSize: 8,
    animation: "qb-pulse 1.2s ease-in-out infinite",
  },
  headline: {
    fontSize: 11.5,
    color: "#cbd5e1",
    lineHeight: 1.4,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  },
  counts: {
    fontSize: 10.5,
    color: "#64748b",
  },
  chevron: {
    flexShrink: 0,
    fontSize: 10,
    color: "#71717a",
    marginTop: 4,
  },
  detail: {
    maxHeight: 360,
    overflow: "auto",
    borderTop: "1px solid rgba(255,255,255,0.06)",
    background: "rgba(8,8,10,0.55)",
  },
};
