/**
 * Specialist / analyst slot → Core agent.invoke (QUBIT_CORE_BACKEND=rust).
 * Parent session is the workflow-bound primary; callee is subagent (or primary).
 */

import { randomUUID } from "node:crypto";
import { resolveCoreBackend } from "./core-runtime";
import { asRustCoreClient, ensureCoreSession } from "./ensure-core-session";
import { syncPrimeSpecsToRustCore } from "./bootstrap";
import {
  beginCoreMonitorTurn,
  finalizeCoreMonitorTurn,
} from "./project-core-monitor";
import { projectCoreInvocation } from "./project-core-to-graph";
import { buildPrimeAgentSpecs } from "./seed-prime-agent-specs";
import {
  clearPrimeBridgeRunContext,
  setPrimeBridgeRunContext,
} from "./bridge-run-context";
import type { SessionSnapshot } from "./types";

export function resolveCalleeSpecId(input: {
  definitionId?: string;
  role?: string;
}): string {
  if (input.definitionId?.trim()) return input.definitionId.trim();
  const role = input.role?.trim();
  if (role) {
    const specs = buildPrimeAgentSpecs();
    const hit = specs.find((s) => s.labels.includes(role) && s.enabled);
    if (hit) return hit.id;
  }
  return "def-research";
}

function extractAnswerFromInvokeRecord(
  record: Record<string, unknown>
): string {
  const handoff = record.handoff_out;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    const narrative = (handoff as Record<string, unknown>).narrative;
    if (typeof narrative === "string" && narrative.trim()) {
      const t = narrative.trim();
      // Legacy Core stub — not a real specialist answer.
      if (/^invocation\s+\S+\s*→\s*child turn\b/i.test(t)) return "";
      if (/\(no answer_text\)\s*$/i.test(t)) return "";
      return t;
    }
  }
  const delivery = record.delivery;
  if (delivery && typeof delivery === "object") {
    const status = (delivery as { status?: string }).status;
    if (status === "failed" || status === "cancelled") {
      return `invoke ${status}`;
    }
  }
  return "";
}

/**
 * Invoke a specialist on Core and return final text for slot / A2A callers.
 */
export async function reasonSpecialistViaCore(input: {
  workflowRunId: string;
  runId?: string;
  traceId?: string;
  calleeSpecId: string;
  role: string;
  goal: string;
  context?: string;
  maxIterations?: number;
  callerRole?: string;
}): Promise<{
  text: string;
  invocationId: string;
  childSessionId?: string;
  childTurnId?: string;
  state?: string;
}> {
  if (resolveCoreBackend() !== "rust") {
    throw new Error("reasonSpecialistViaCore requires QUBIT_CORE_BACKEND=rust");
  }

  await syncPrimeSpecsToRustCore();
  const { sessionId, agentInstanceId } = await ensureCoreSession({
    workflowId: input.workflowRunId,
    interactionMode: "agent",
  });
  const client = asRustCoreClient();
  const parentSnap = await client.sessionSnapshot(sessionId);
  const parentTurnId =
    parentSnap.active_turn?.turn_id ?? `trn_parent_${randomUUID().slice(0, 8)}`;
  const callerInstanceId =
    agentInstanceId ?? parentSnap.session.agent_instance_id;

  const goalParts = [input.goal.trim()];
  if (input.context?.trim()) {
    goalParts.push(`[context]\n${input.context.trim()}`);
  }
  const goal = goalParts.join("\n\n");
  const invocationId = `inv_${randomUUID()}`;
  const runId = input.runId?.trim() || invocationId;
  const traceId = input.traceId?.trim() || invocationId;

  await beginCoreMonitorTurn({
    workflowId: input.workflowRunId,
    runId,
    traceId,
    role: input.role,
  });

  setPrimeBridgeRunContext({
    workflowId: input.workflowRunId,
    runId,
    traceId,
    role: input.role,
    sessionId,
  });

  let record: Record<string, unknown>;
  try {
    record = await client.invokeAgent({
      invocation_id: invocationId,
      parent_session_id: sessionId,
      parent_turn_id: parentTurnId,
      caller_instance_id: callerInstanceId,
      callee_spec_id: input.calleeSpecId,
      goal,
      budget: {
        max_iterations: Math.max(1, input.maxIterations ?? 8),
      },
    });
  } catch (err) {
    clearPrimeBridgeRunContext({
      workflowId: input.workflowRunId,
      runId,
    });
    await finalizeCoreMonitorTurn({
      workflowId: input.workflowRunId,
      runId,
      ok: false,
      turn: null,
    });
    throw err;
  }

  const childSessionId =
    typeof record.child_session_id === "string"
      ? record.child_session_id
      : undefined;
  const childTurnId =
    typeof record.child_turn_id === "string" ? record.child_turn_id : undefined;
  const state = typeof record.state === "string" ? record.state : undefined;

  // Prefer child session answer_text over handoff narrative (may still be stub).
  let text = "";
  let childTurn: SessionSnapshot["active_turn"] | null = null;
  if (childSessionId) {
    try {
      const childSnap = await client.sessionSnapshot(childSessionId);
      const answer = childSnap.active_turn?.answer_text;
      if (typeof answer === "string" && answer.trim()) text = answer.trim();
      childTurn = childSnap.active_turn ?? null;
    } catch {
      /* ignore */
    }
  }
  if (!text) {
    text = extractAnswerFromInvokeRecord(record);
  }
  if (!text) {
    text =
      state === "completed"
        ? `（Prime Core invoke ${input.role} 完成，无文本）`
        : `Prime Core invoke ${input.role} ${state ?? "unknown"}`;
  }

  const delivery =
    record.delivery && typeof record.delivery === "object"
      ? (record.delivery as { status?: string })
      : undefined;

  await projectCoreInvocation({
    workflowRunId: input.workflowRunId,
    runId,
    traceId,
    callerRole: input.callerRole ?? "orchestrator",
    calleeSpecId: input.calleeSpecId,
    calleeLabel: input.role,
    goal,
    invocationId,
    childSessionId,
    childTurnId,
    state,
    deliveryStatus: delivery?.status,
    resultText: text,
  });

  await finalizeCoreMonitorTurn({
    workflowId: input.workflowRunId,
    runId,
    ok: state !== "failed" && state !== "cancelled",
    turn: childTurn,
  });

  clearPrimeBridgeRunContext({
    workflowId: input.workflowRunId,
    runId,
  });

  return {
    text,
    invocationId,
    ...(childSessionId ? { childSessionId } : {}),
    ...(childTurnId ? { childTurnId } : {}),
    ...(state ? { state } : {}),
  };
}
