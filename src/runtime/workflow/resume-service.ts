/**
 * Unified workflow resume — Cursor-style "continue from checkpoint".
 *
 * Modes:
 *   - checkpoint: Prefer Bun agent_checkpoint_snapshot (TS ReAct) or Core session
 *     history (Prime path). Dispatches workflow_resume with resume=true.
 *   - fresh: Restart from goal without snapshot (workflow_retry).
 *
 * Eligibility: partial / failed / awaiting_approval with recoverable state.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { agentCheckpointSnapshot, workflowRun } from "../../db/sqlite/schema";
import { dispatchTaskToRole } from "../agent-pool";
import { resolveCoreBackend } from "../prime/core-runtime";
import { setWorkflowState } from "./workflow-state-machine";

export type WorkflowResumeMode = "checkpoint" | "fresh";

export type WorkflowResumeStatus = {
  workflowId: string;
  status: string;
  resumable: boolean;
  reason: string | null;
  hasBunSnapshot: boolean;
  hasCoreSession: boolean;
  snapshot?: {
    phase: string;
    stepIndex: number;
    createdAt: string;
  };
  suggestedMode: WorkflowResumeMode;
  interruptionHint: string | null;
};

function tableExists(name: string): boolean {
  try {
    const sqlite = getSqliteForTesting();
    const row = sqlite
      .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  } catch {
    return false;
  }
}

async function loadLatestBunSnapshot(workflowId: string): Promise<{
  phase: string;
  stepIndex: number;
  createdAt: string;
} | null> {
  try {
    const db = await getDb();
    const rows = await db
      .select({
        phase: agentCheckpointSnapshot.phase,
        stepIndex: agentCheckpointSnapshot.stepIndex,
        createdAt: agentCheckpointSnapshot.createdAt,
      })
      .from(agentCheckpointSnapshot)
      .where(eq(agentCheckpointSnapshot.workflowRunId, workflowId))
      .orderBy(desc(agentCheckpointSnapshot.stepIndex))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      phase: row.phase,
      stepIndex: row.stepIndex,
      createdAt: row.createdAt,
    };
  } catch {
    return null;
  }
}

function hasCoreSessionForWorkflow(workflowId: string): boolean {
  // Core sessions live in ~/.qubit/core/runtime.sqlite; Bun only knows via workspace id.
  // Heuristic: research_team_interaction or tool_call_log with agent.invoke / memory tools
  // indicates a Core-backed run that can continue in the same session.
  try {
    const sqlite = getSqliteForTesting();
    if (!tableExists("research_team_interaction")) return false;
    const row = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM research_team_interaction WHERE workflow_run_id = ?`
      )
      .get(workflowId) as { c: number };
    return Number(row?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

function interruptionHintFromDelivery(workflowId: string): string | null {
  try {
    const sqlite = getSqliteForTesting();
    if (!tableExists("workflow_delivery_verdict")) return null;
    const row = sqlite
      .prepare(
        `SELECT state, reason_codes_json AS reasons
         FROM workflow_delivery_verdict
         WHERE workflow_run_id = ?
         ORDER BY created_at DESC LIMIT 1`
      )
      .get(workflowId) as { state: string; reasons: string } | undefined;
    if (!row) return null;
    const reasons = JSON.parse(row.reasons || "[]") as string[];
    const timeout = reasons.find((r) => /timeout/i.test(r));
    if (timeout) return "上次运行因超时中断，可从检查点继续。";
    if (row.state === "partial" || row.state === "failed") {
      return "上次运行未完整交付，可从检查点继续。";
    }
    return null;
  } catch {
    return null;
  }
}

export async function getWorkflowResumeStatus(
  workflowId: string
): Promise<WorkflowResumeStatus> {
  const db = await getDb();
  const rows = await db
    .select({
      id: workflowRun.id,
      status: workflowRun.status,
      goal: workflowRun.goal,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  const wf = rows[0];
  if (!wf) {
    return {
      workflowId,
      status: "missing",
      resumable: false,
      reason: "workflow_not_found",
      hasBunSnapshot: false,
      hasCoreSession: false,
      suggestedMode: "fresh",
      interruptionHint: null,
    };
  }

  const snapshot = await loadLatestBunSnapshot(workflowId);
  const hasBunSnapshot = Boolean(snapshot);
  const hasCoreSession =
    resolveCoreBackend() === "rust" && hasCoreSessionForWorkflow(workflowId);
  const status = wf.status;
  const terminalResumable =
    status === "partial" ||
    status === "failed" ||
    status === "awaiting_approval";
  const canCheckpoint = hasBunSnapshot || hasCoreSession;
  // Only terminal interrupted states are resumable. pending/running must NOT
  // stay "resumable" — otherwise clicking Resume leaves the banner forever
  // while the new turn is already starting.
  const deliveryHint = interruptionHintFromDelivery(workflowId);
  const orphanRunning =
    (status === "running" || status === "pending") &&
    Boolean(deliveryHint && /超时|中断|timeout/i.test(deliveryHint));
  const resumable =
    (terminalResumable || orphanRunning) && (canCheckpoint || terminalResumable);
  const hint =
    deliveryHint ??
    (status === "partial"
      ? "工作流以部分结果收口，可继续完成剩余步骤。"
      : status === "failed"
        ? "工作流失败，若有检查点可尝试续跑。"
        : status === "awaiting_approval"
          ? "等待人工确认；确认后可继续。"
          : orphanRunning
            ? "运行似乎已中断，可从检查点继续。"
            : null);

  return {
    workflowId,
    status,
    resumable: Boolean(resumable),
    reason: resumable
      ? canCheckpoint
        ? "checkpoint_available"
        : "restart_from_goal"
      : status === "completed"
        ? "already_completed"
        : status === "cancelled"
          ? "cancelled"
          : "not_resumable",
    hasBunSnapshot,
    hasCoreSession,
    ...(snapshot ? { snapshot } : {}),
    suggestedMode: canCheckpoint ? "checkpoint" : "fresh",
    interruptionHint: hint,
  };
}

export async function resumeWorkflow(input: {
  workflowId: string;
  mode?: WorkflowResumeMode;
  note?: string;
}): Promise<{
  ok: boolean;
  taskId: string;
  mode: WorkflowResumeMode;
  status: WorkflowResumeStatus;
}> {
  const status = await getWorkflowResumeStatus(input.workflowId);
  if (!status.resumable && status.status !== "awaiting_approval") {
    throw new Error(`workflow_not_resumable:${status.reason ?? status.status}`);
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, input.workflowId))
    .limit(1);
  const wf = rows[0];
  if (!wf) throw new Error("workflow_not_found");

  const mode: WorkflowResumeMode =
    input.mode ?? status.suggestedMode;
  const useCheckpoint = mode === "checkpoint" && (status.hasBunSnapshot || status.hasCoreSession);
  const taskId = randomUUID();

  await setWorkflowState(input.workflowId, "pending", {
    reason: useCheckpoint ? "user-resume-checkpoint" : "user-resume-fresh",
  });

  await dispatchTaskToRole({
    workflowId: input.workflowId,
    role: "orchestrator",
    payload: {
      taskId,
      taskType: useCheckpoint ? "workflow_resume" : "workflow_retry",
      assignedRole: "orchestrator",
      params: {
        workflowRunId: input.workflowId,
        goal: wf.goal,
        mode: wf.mode,
        resume: useCheckpoint,
        ...(input.note?.trim()
          ? {
              context: `[user_resume_note]\n${input.note.trim()}`,
            }
          : {}),
        resumeSource: "ui_resume_button",
      },
    },
  });

  return {
    ok: true,
    taskId,
    mode: useCheckpoint ? "checkpoint" : "fresh",
    status: await getWorkflowResumeStatus(input.workflowId),
  };
}
