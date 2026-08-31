/**
 * PlanCard —— Orchestrator 对用户可见的分步计划/TODO 与 Goal 进度。
 *
 * 数据来自后端 `update_plan`：SSE `type:"plan"`。在对话流中按「任务段落」内联展示——
 * 新任务新开一段；同任务进度更新只刷新当前段；旧段留在上方。
 */
import type { CSSProperties } from "react";
import { useState } from "react";
import type {
  AgentControlMode,
  ResearchPhase,
  ResearchPhaseState,
  ResearchPhaseStatus,
} from "../../api/types";

export type PlanStepStatus = "pending" | "in_progress" | "done" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  note?: string;
  researchPhase?: ResearchPhase;
}

export interface OrchestratorPlan {
  mode?: AgentControlMode;
  researchPhase?: ResearchPhase;
  researchPhases?: ResearchPhaseState[];
  goal?: {
    text?: string;
    status?: "planning" | "executing" | "paused" | "completed" | "blocked" | "cleared";
    completedSteps?: number;
    totalSteps?: number;
    successCriteria?: string[];
    constraints?: string[];
    verification?: { evidenceCount?: number; summary?: string; verifiedAt?: string };
    blocker?: string;
  };
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

const RESEARCH_PHASE_LABEL: Record<ResearchPhase, string> = {
  scope: "范围",
  plan: "计划",
  evidence: "证据",
  analysis: "分析",
  validation: "验证",
  delivery: "交付",
};

const RESEARCH_PHASE_STATUS_LABEL: Record<ResearchPhaseStatus, string> = {
  pending: "待开始",
  active: "进行中",
  completed: "已完成",
  revisited: "回访",
  blocked: "受阻",
};

export function PlanCard({
  plan,
  onExecute,
  onGoalAction,
  executeDisabled = false,
  defaultOpen = true,
  segmentLabel,
}: {
  plan: OrchestratorPlan | null;
  onExecute?: () => void;
  onGoalAction?: (action: "pause" | "resume" | "edit" | "clear") => void;
  executeDisabled?: boolean;
  /** Past task segments usually start collapsed. */
  defaultOpen?: boolean;
  /** e.g. "任务 1" */
  segmentLabel?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const steps = plan?.steps ?? [];
  if (steps.length === 0) return null;

  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const active = steps.find((s) => s.status === "in_progress");
  const mode = plan?.mode ?? "agent";
  const headerLabel =
    mode === "plan"
      ? "规划方案"
      : mode === "goal"
        ? "目标进度"
        : mode === "ask"
          ? "问答要点"
          : mode === "diagnose"
            ? "Diagnose 进度"
            : "执行计划";
  const modeLabel =
    mode === "plan"
      ? "PLAN"
      : mode === "goal"
        ? "GOAL"
        : mode === "ask"
          ? "ASK"
          : mode === "diagnose"
            ? "DIAGNOSE"
            : "AGENT";
  const goalStatusLabel =
    plan?.goal?.status === "completed"
      ? "已完成"
      : plan?.goal?.status === "paused"
        ? "已暂停"
        : plan?.goal?.status === "blocked"
          ? "受阻"
          : plan?.goal?.status === "executing"
            ? "执行中"
            : "规划中";

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
        {segmentLabel ? <span style={styles.segmentBadge}>{segmentLabel}</span> : null}
        <span style={styles.modeBadge}>{modeLabel}</span>
        {plan?.researchPhase ? (
          <span style={styles.phaseBadge}>研究·{RESEARCH_PHASE_LABEL[plan.researchPhase]}</span>
        ) : null}
        {headerLabel}（{done}/{steps.length}）
        {mode === "goal" ? <span style={styles.goalStatus}>{goalStatusLabel}</span> : null}
        {!open && active ? <span style={styles.activeHint}>· {active.title}</span> : null}
      </button>
      {open ? (
        <>
          {plan?.researchPhases && plan.researchPhases.length > 0 ? (
            <div style={styles.phaseStates}>
              {plan.researchPhases.map((state) => (
                <span key={state.phase} style={styles.phaseState}>
                  {RESEARCH_PHASE_LABEL[state.phase]}·{RESEARCH_PHASE_STATUS_LABEL[state.status]}
                </span>
              ))}
            </div>
          ) : null}
          {mode === "goal" && plan?.goal?.text ? (
            <div style={styles.goalText}>{plan.goal.text}</div>
          ) : null}
          {mode === "goal" && (plan?.goal?.successCriteria?.length ?? 0) > 0 ? (
            <div style={styles.criteria}>完成标准：{plan?.goal?.successCriteria?.join("；")}</div>
          ) : null}
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
                  {s.researchPhase ? (
                    <span style={styles.stepPhase}> · {RESEARCH_PHASE_LABEL[s.researchPhase]}</span>
                  ) : null}
                  {s.note ? <span style={styles.note}> — {s.note}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          {mode === "plan" && onExecute ? (
            <div style={styles.actions}>
              <button
                type="button"
                style={{
                  ...styles.executeButton,
                  ...(executeDisabled ? styles.executeButtonDisabled : null),
                }}
                disabled={executeDisabled}
                onClick={onExecute}
              >
                按此计划执行 · Goal
              </button>
              <span style={styles.executeHint}>保留当前计划并切换到自主闭环执行</span>
            </div>
          ) : null}
          {mode === "goal" && onGoalAction ? (
            <div style={styles.actions}>
              {plan?.goal?.status === "paused" ? (
                <button
                  type="button"
                  style={styles.goalAction}
                  onClick={() => onGoalAction("resume")}
                >
                  恢复
                </button>
              ) : plan?.goal?.status !== "completed" && plan?.goal?.status !== "blocked" ? (
                <button
                  type="button"
                  style={styles.goalAction}
                  onClick={() => onGoalAction("pause")}
                >
                  暂停
                </button>
              ) : null}
              <button type="button" style={styles.goalAction} onClick={() => onGoalAction("edit")}>
                编辑目标
              </button>
              <button
                type="button"
                style={styles.goalActionDanger}
                onClick={() => onGoalAction("clear")}
              >
                清除
              </button>
            </div>
          ) : null}
        </>
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
  segmentBadge: {
    padding: "1px 5px",
    borderRadius: 4,
    border: "1px solid rgba(167,139,250,0.45)",
    color: "#c4b5fd",
    fontSize: 9,
    letterSpacing: "0.04em",
    fontWeight: 600,
  },
  modeBadge: {
    padding: "1px 5px",
    borderRadius: 4,
    border: "1px solid rgba(125,211,252,0.4)",
    fontSize: 9,
    letterSpacing: "0.08em",
  },
  phaseBadge: {
    padding: "1px 5px",
    borderRadius: 4,
    border: "1px solid rgba(74,222,128,0.38)",
    color: "#86efac",
    fontSize: 9,
    letterSpacing: "0.04em",
    fontWeight: 500,
  },
  phaseStates: {
    display: "flex",
    flexWrap: "wrap",
    gap: 4,
    padding: "0 10px 7px 32px",
  },
  phaseState: {
    padding: "2px 5px",
    borderRadius: 4,
    border: "1px solid rgba(161,161,170,0.28)",
    color: "#a1a1aa",
    fontSize: 9,
  },
  goalStatus: {
    marginLeft: "auto",
    color: "#a5f3fc",
    fontSize: 10,
    fontWeight: 500,
  },
  goalText: {
    margin: "0 10px 7px",
    padding: "7px 8px",
    borderLeft: "2px solid rgba(56,189,248,0.55)",
    color: "#d4d4d8",
    background: "rgba(15,23,42,0.35)",
    fontSize: 11,
    lineHeight: 1.45,
  },
  criteria: {
    margin: "0 10px 7px",
    color: "#a5b4fc",
    fontSize: 10,
    lineHeight: 1.45,
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
  stepPhase: { color: "#86efac", fontSize: 10, fontWeight: 500 },
  note: { color: "#71717a", fontWeight: 400 },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "2px 10px 10px 32px",
  },
  executeButton: {
    border: "1px solid rgba(56,189,248,0.55)",
    borderRadius: 6,
    background: "rgba(56,189,248,0.13)",
    color: "#bae6fd",
    padding: "5px 9px",
    fontFamily: "inherit",
    fontSize: 10,
    fontWeight: 600,
    cursor: "pointer",
  },
  goalAction: {
    border: "1px solid rgba(125,211,252,0.4)",
    borderRadius: 5,
    padding: "3px 8px",
    background: "rgba(56,189,248,0.08)",
    color: "#bae6fd",
    fontSize: 10,
    cursor: "pointer",
  },
  goalActionDanger: {
    border: "1px solid rgba(248,113,113,0.35)",
    borderRadius: 5,
    padding: "3px 8px",
    background: "rgba(248,113,113,0.06)",
    color: "#fca5a5",
    fontSize: 10,
    cursor: "pointer",
  },
  executeButtonDisabled: { opacity: 0.45, cursor: "not-allowed" },
  executeHint: { color: "#71717a", fontSize: 9 },
};
