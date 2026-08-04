/**
 * Cursor/Codex 风格的「还在跑」状态条：思考中 / 调用工具 / 专家运行。
 * 给 Orchestrator 右栏用，避免 chatInFlight 结束后误显示空闲。
 */
import { LoaderCircle, Network, Sparkles, Wrench } from "lucide-react";
import { type CSSProperties, type FC, useMemo } from "react";
import type { StepStreamEvent } from "../../api/types";
import type { SubAgentRunSummary } from "../../lib/subAgentRuns";
import {
  type OrchestratorLivePhase,
  resolveOrchestratorLivePhase,
} from "./orchestratorLivePhase";

export type { OrchestratorLivePhase };
export { resolveOrchestratorLivePhase };

export const OrchestratorLiveStatus: FC<{
  running: boolean;
  chatInFlight: boolean;
  pendingHitl: boolean;
  activity?: { tool: string; why: string } | null;
  streamEvents: StepStreamEvent[];
  subAgentRuns: SubAgentRunSummary[];
  thinkingText?: string | null;
}> = ({
  running,
  chatInFlight,
  pendingHitl,
  activity,
  streamEvents,
  subAgentRuns,
  thinkingText,
}) => {
  const phase = useMemo(
    () =>
      resolveOrchestratorLivePhase({
        running,
        chatInFlight,
        pendingHitl,
        activity,
        streamEvents,
        subAgentRuns,
        thinkingText,
      }),
    [running, chatInFlight, pendingHitl, activity, streamEvents, subAgentRuns, thinkingText]
  );

  if (!phase) return null;

  const Icon =
    phase.kind === "tool"
      ? Wrench
      : phase.kind === "expert"
        ? Network
        : phase.kind === "thinking"
          ? Sparkles
          : LoaderCircle;

  return (
    <div
      className="qb-orch-live-status"
      style={styles.bar}
      role="status"
      aria-live="polite"
      data-phase={phase.kind}
    >
      <Icon
        size={14}
        aria-hidden
        className={
          phase.kind === "thinking" || phase.kind === "working" || phase.kind === "tool"
            ? "qb-orch-live-status__spin"
            : undefined
        }
        style={phase.kind === "thinking" || phase.kind === "working" ? styles.spin : undefined}
      />
      <div style={styles.text}>
        <strong style={styles.label}>{phase.label}</strong>
        {"detail" in phase && phase.detail ? (
          <span style={styles.detail}>{phase.detail}</span>
        ) : null}
      </div>
      <span style={styles.pulse} aria-hidden />
    </div>
  );
};

const styles: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "0 0 8px",
    padding: "8px 10px",
    borderRadius: 8,
    border: "1px solid rgba(56,189,248,0.35)",
    background: "linear-gradient(90deg, rgba(14,165,233,0.12), rgba(15,23,42,0.55))",
    color: "#e2e8f0",
    fontSize: 12,
  },
  text: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 0,
    flex: 1,
  },
  label: {
    fontWeight: 600,
    fontSize: 12,
    color: "#f8fafc",
  },
  detail: {
    color: "#94a3b8",
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  spin: {
    color: "#38bdf8",
    flexShrink: 0,
    animation: "qbSpin 1s linear infinite",
  },
  pulse: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    background: "#38bdf8",
    boxShadow: "0 0 0 0 rgba(56,189,248,0.55)",
    animation: "qbPulseDot 1.4s ease-out infinite",
    flexShrink: 0,
  },
};
