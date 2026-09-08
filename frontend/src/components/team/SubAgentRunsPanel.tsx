/**
 * 右栏 Orchestrator 对话内的「子 Agent 运行」面板。
 * 点击专家后由父级跳转到独立的子对话上下文，避免把完整轨迹挤在进度卡里。
 */
import { ChevronDown } from "lucide-react";
import { type CSSProperties, type FC, useState } from "react";
import type { SubAgentRunSummary, SubAgentRunStatus } from "../../lib/subAgentRuns";
import { avatarColorFor, avatarLabelFor, formatRoleName } from "./conversationAvatar";

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
  selectedRole?: string | null;
  onSelectRun?: (run: SubAgentRunSummary) => void;
}> = ({ runs, selectedRole = null, onSelectRun }) => {
  const [open, setOpen] = useState(true);

  if (runs.length === 0) return null;

  const activeCount = runs.filter((r) => r.status === "running" || r.status === "queued").length;
  const failedCount = runs.filter((r) => r.status === "failed").length;

  return (
    <div style={styles.box} data-qb-subagent-runs>
      <button
        type="button"
        style={styles.toggle}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? "折叠专家进度" : "展开专家进度"}
      >
        <ChevronDown
          size={15}
          aria-hidden
          style={{
            ...styles.chevronToggle,
            transform: open ? undefined : "rotate(-90deg)",
          }}
        />
        <span style={styles.title}>专家进度</span>
        <span style={styles.count}>{runs.length} 位专家</span>
        <span style={styles.summary}>
          {activeCount > 0 ? (
            <span style={{ ...styles.metric, color: STATUS_COLOR.running }}>
              {activeCount} 个进行中
            </span>
          ) : failedCount > 0 ? (
            <span style={{ ...styles.metric, color: STATUS_COLOR.failed }}>
              {failedCount} 个失败
            </span>
          ) : (
            <span style={{ ...styles.metric, color: STATUS_COLOR.done }}>已完成</span>
          )}
        </span>
      </button>
      {open ? (
        <div style={styles.list}>
          {runs.map((run) => {
            const selected = selectedRole === run.role;
            const { bg, fg } = avatarColorFor(run.role);
            return (
              <div key={run.role} style={styles.card}>
                <button
                  type="button"
                  style={{ ...styles.summaryBtn, ...(selected ? styles.summaryBtnSelected : null) }}
                  aria-pressed={selected}
                  onClick={() => onSelectRun?.(run)}
                  title={`打开${formatRoleName(run.role)}的子对话上下文`}
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
                    {selected ? "打开中" : "查看对话 ▸"}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
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
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    minHeight: 36,
    padding: "8px 10px",
    border: "none",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
    textAlign: "left",
  },
  chevronToggle: {
    flexShrink: 0,
    color: "#94a3b8",
    transition: "transform 160ms ease",
  },
  title: {
    fontSize: 12,
    fontWeight: 650,
    color: "#e2e8f0",
  },
  count: {
    padding: "2px 6px",
    borderRadius: 999,
    fontSize: 10,
    color: "#94a3b8",
    background: "rgba(148,163,184,0.16)",
    fontVariantNumeric: "tabular-nums",
  },
  summary: {
    marginLeft: "auto",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 10,
  },
  metric: {
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 0,
    borderTop: "1px solid rgba(255,255,255,0.05)",
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
  summaryBtnSelected: {
    background: "rgba(56,189,248,0.12)",
    boxShadow: "inset 2px 0 0 #38bdf8",
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
    overflow: "hidden",
    textOverflow: "ellipsis",
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical",
  },
  counts: {
    fontSize: 10.5,
    color: "#94a3b8",
  },
  chevron: {
    flexShrink: 0,
    fontSize: 11,
    color: "#7dd3fc",
    marginTop: 4,
  },
};
