/**
 * PlanCard —— Orchestrator 对用户可见的分步计划/TODO（Coding-Agent 体验 P1，
 * docs/CODING_AGENT_EXPERIENCE_DESIGN.md）。
 *
 * 数据来自后端 `update_plan` 工具：写入 workflow_run.plan_json 并经 SSE `type:"plan"`
 * 推流。本组件纯展示——把步骤按状态渲染成一份会随进展勾选的待办清单，置于右栏
 * Orchestrator 对话框顶部，让用户随时看到「它打算怎么做、做到哪一步」。
 */
import type { CSSProperties } from "react";
import { useState } from "react";

export type PlanStepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  note?: string;
}

export interface OrchestratorPlan {
  steps: PlanStep[];
  updatedAt?: string;
}

const STATUS_ICON: Record<PlanStepStatus, string> = {
  pending: "○",
  in_progress: "◐",
  done: "✓",
  skipped: "⊘",
};

const STATUS_COLOR: Record<PlanStepStatus, string> = {
  pending: "#71717a",
  in_progress: "#38bdf8",
  done: "#4ade80",
  skipped: "#a1a1aa",
};

export function PlanCard({ plan }: { plan: OrchestratorPlan | null }) {
  const [open, setOpen] = useState(true);
  const steps = plan?.steps ?? [];
  if (steps.length === 0) return null;

  const done = steps.filter((s) => s.status === "done").length;
  const active = steps.find((s) => s.status === "in_progress");

  return (
    <div style={styles.box}>
      <button
        type="button"
        style={styles.header}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span aria-hidden style={{ fontSize: 10 }}>
          {open ? "▾" : "▸"}
        </span>
        🗺️ 执行计划（{done}/{steps.length}）
        {!open && active ? <span style={styles.activeHint}>· {active.title}</span> : null}
      </button>
      {open ? (
        <ol style={styles.list}>
          {steps.map((s) => (
            <li key={s.id} style={styles.item}>
              <span
                aria-hidden
                style={{
                  ...styles.icon,
                  color: STATUS_COLOR[s.status],
                  ...(s.status === "in_progress" ? styles.iconPulse : null),
                }}
              >
                {STATUS_ICON[s.status]}
              </span>
              <span
                style={{
                  ...styles.title,
                  ...(s.status === "done" ? styles.titleDone : null),
                  ...(s.status === "in_progress" ? styles.titleActive : null),
                }}
              >
                {s.title}
                {s.note ? <span style={styles.note}> — {s.note}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  box: {
    marginBottom: 10,
    border: "1px solid rgba(56,189,248,0.32)",
    borderRadius: 8,
    background: "rgba(56,189,248,0.05)",
    overflow: "hidden",
  },
  header: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    background: "transparent",
    border: "none",
    color: "#7dd3fc",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
    textAlign: "left",
  },
  activeHint: {
    color: "#a1a1aa",
    fontWeight: 400,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: "0 10px 8px 10px",
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  item: { display: "flex", alignItems: "flex-start", gap: 8, lineHeight: 1.45 },
  icon: { flexShrink: 0, width: 14, textAlign: "center", fontSize: 12, marginTop: 1 },
  iconPulse: { animation: "qbPulse 1.4s ease-in-out infinite" },
  title: { fontSize: 12, color: "#d4d4d8", minWidth: 0 },
  titleDone: { color: "#71717a", textDecoration: "line-through" },
  titleActive: { color: "#e4e4e7", fontWeight: 600 },
  note: { color: "#71717a", fontWeight: 400 },
};
