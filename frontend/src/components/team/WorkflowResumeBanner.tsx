/**
 * Cursor-style resume reminder when a workflow was interrupted / partial / failed.
 */
import { useEffect, useState } from "react";
import {
  getWorkflowResumeStatus,
  resumeWorkflow,
  type WorkflowResumeStatus,
} from "../../api/backend";

export function WorkflowResumeBanner(props: {
  workflowRunId: string;
  /**
   * Hide while a chat turn is actively in flight, or after user just resumed
   * (parent sets workflow running / in-flight).
   */
  chatInFlight?: boolean;
  /** Parent workflow status — hide banner once pending/running after resume. */
  workflowStatus?: string | null;
  onResumed?: () => void;
}) {
  const [status, setStatus] = useState<WorkflowResumeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // New workflow selection → allow banner again.
    setDismissed(false);
    setError(null);
  }, [props.workflowRunId]);

  useEffect(() => {
    let cancelled = false;
    const st = props.workflowStatus ?? "";
    if (
      !props.workflowRunId ||
      props.chatInFlight ||
      dismissed ||
      st === "running" ||
      st === "pending"
    ) {
      if (!cancelled) setStatus(null);
      return;
    }
    const load = async () => {
      try {
        const next = await getWorkflowResumeStatus(props.workflowRunId);
        if (!cancelled) setStatus(next);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 8_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    props.workflowRunId,
    props.chatInFlight,
    props.workflowStatus,
    dismissed,
  ]);

  const wfSt = props.workflowStatus ?? status?.status ?? "";
  if (
    props.chatInFlight ||
    dismissed ||
    wfSt === "running" ||
    wfSt === "pending" ||
    !status?.resumable
  ) {
    return null;
  }

  const hint =
    status.interruptionHint ||
    (status.hasBunSnapshot || status.hasCoreSession
      ? "检测到可恢复的检查点，可从中断处继续。"
      : "可重新启动本工作流。");

  return (
    <div
      role="status"
      style={{
        margin: "0 12px 8px",
        padding: "10px 12px",
        borderRadius: 8,
        border: "1px solid color-mix(in srgb, var(--accent, #6c8cff) 40%, transparent)",
        background:
          "color-mix(in srgb, var(--accent, #6c8cff) 12%, var(--panel-bg, #12141a))",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: "1 1 200px", minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
          工作流可继续
        </div>
        <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>{hint}</div>
        {status.snapshot ? (
          <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
            checkpoint · {status.snapshot.phase} · step {status.snapshot.stepIndex}
          </div>
        ) : null}
        {error ? (
          <div style={{ fontSize: 12, color: "var(--danger, #f87171)", marginTop: 4 }}>
            {error}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          void resumeWorkflow(props.workflowRunId, {
            mode: status.suggestedMode,
          })
            .then(() => {
              setDismissed(true);
              setStatus(null);
              props.onResumed?.();
            })
            .catch((err) => {
              setError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => setBusy(false));
        }}
        style={{
          flex: "0 0 auto",
          padding: "8px 14px",
          borderRadius: 6,
          border: "none",
          cursor: busy ? "wait" : "pointer",
          background: "var(--accent, #6c8cff)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {busy
          ? "续跑中…"
          : status.suggestedMode === "checkpoint"
            ? "从检查点继续"
            : "重新启动"}
      </button>
    </div>
  );
}
