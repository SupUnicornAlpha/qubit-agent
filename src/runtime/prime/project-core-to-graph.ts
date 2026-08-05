/**
 * Project Rust Core turns / invokes into research_team_interaction
 * so TeamPage topology + pixel office keep working while we cut TS ReAct.
 */

import {
  logResearchTeamInteraction,
  projectWorkflowFinalAnswer,
} from "../research-team/interaction-log";
import {
  publishCoreToolCallEnd,
  publishCoreToolCallStart,
} from "./project-core-activity";
import {
  recordCoreMonitorToolCall,
  recordCoreMonitorToolStart,
} from "./project-core-monitor";
import type { SessionSnapshot } from "./types";

/**
 * Guard against Core stub / legacy FakeModel echo leaking assembled context
 * (workspace paths, MODE=agent, session ids) into the chat UI.
 */
export function sanitizeCoreAnswerText(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  if (
    text === "Prime Core model sample" ||
    text === "Prime Core tools / invoke" ||
    /^Prime Core model sample\b/i.test(text)
  ) {
    return "";
  }
  if (text.startsWith("echo:")) {
    return "(Core 模型未正确配置，已拦截上下文回显。请配置 LLM 后重试。)";
  }
  const looksLikeLeakedContext =
    (text.includes("MODE=agent:") || text.includes("MODE=plan:")) &&
    (text.includes("根路径：") ||
      text.includes("QUBIT.md") ||
      text.includes("AGENTS.md") ||
      text.includes("kind=Primary") ||
      text.includes("session=ses_"));
  if (looksLikeLeakedContext) {
    return "(Core 返回了内部上下文而非回答，已拦截。请确认 Core 已接上真实 LLM 并重启。)";
  }
  return text;
}

export async function projectCoreUserMessage(input: {
  workflowRunId: string;
  text: string;
}): Promise<void> {
  await logResearchTeamInteraction({
    workflowRunId: input.workflowRunId,
    fromRole: "user",
    toRole: "orchestrator",
    kind: "llm_message",
    contentText: input.text.slice(0, 4000),
    payloadJson: { phase: "prime_core_user", backend: "rust" },
  });
}

export async function projectCoreTurnResult(input: {
  workflowRunId: string;
  conversationTurnId?: string;
  snap: SessionSnapshot;
  fallbackText?: string;
  sourceTaskType?: string;
}): Promise<void> {
  const turn = input.snap.active_turn;
  const fromWire =
    typeof turn?.answer_text === "string"
      ? sanitizeCoreAnswerText(turn.answer_text)
      : "";
  const text =
    fromWire ||
    sanitizeCoreAnswerText(input.fallbackText ?? "") ||
    (turn?.delivery?.status === "delivered"
      ? "（Prime Core 已完成 turn，无文本回传）"
      : `Prime Core turn ${turn?.state ?? "unknown"} / delivery=${turn?.delivery?.status ?? "n/a"}`);

  await projectWorkflowFinalAnswer({
    workflowRunId: input.workflowRunId,
    contentText: text,
    sourceTaskType: input.sourceTaskType ?? "orchestrator_chat_prime",
    ...(input.conversationTurnId
      ? { conversationTurnId: input.conversationTurnId }
      : {}),
    payloadJson: {
      backend: "rust",
      turnId: turn?.turn_id,
      turnState: turn?.state,
      lifecycle: turn?.lifecycle,
      delivery: turn?.delivery,
    },
  });
}

/** research_team_execute (Bun MSA) → topology edges under rust valve */
export async function projectTeamResearchEdges(input: {
  workflowRunId: string;
  attendedRoles?: string[];
  ticker?: string;
  fusionId?: string;
}): Promise<void> {
  const roles = input.attendedRoles?.filter(Boolean) ?? [];
  for (const role of roles) {
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: "orchestrator",
      toRole: role,
      kind: "tool_call",
      toolKind: "prime_team_msa",
      toolName: "research_team_execute",
      contentText: input.ticker
        ? `team slot ${role} for ${input.ticker}`
        : `team slot ${role}`,
      payloadJson: {
        backend: "rust",
        phase: "prime_team_msa_bridge",
        fusionId: input.fusionId,
      },
    });
  }
}

/** agent.invoke → topology edge + ChatExecutionActivity (supports Running → terminal). */
export async function projectCoreInvocation(input: {
  workflowRunId: string;
  runId?: string;
  traceId?: string;
  callerRole?: string;
  calleeSpecId: string;
  calleeLabel?: string;
  goal: string;
  invocationId: string;
  childSessionId?: string;
  childTurnId?: string;
  state?: string;
  deliveryStatus?: string;
  /** When true, only emit start (for mid-turn Running). */
  startOnly?: boolean;
  /** When true, skip start (already emitted). */
  endOnly?: boolean;
}): Promise<void> {
  const toRole =
    input.calleeLabel?.trim() ||
    input.calleeSpecId.replace(/^def-/, "").replace(/-/g, "_") ||
    "subagent";
  const runId = input.runId?.trim() || input.invocationId;
  const traceId = input.traceId?.trim() || input.invocationId;
  const activityCtx = {
    workflowId: input.workflowRunId,
    runId,
    traceId,
    role: input.callerRole ?? "orchestrator",
  };
  const state = input.state ?? "unknown";
  const isTerminal =
    state === "completed" ||
    state === "failed" ||
    state === "cancelled" ||
    state === "timed_out";

  if (!input.endOnly) {
    publishCoreToolCallStart(activityCtx, {
      toolCallId: input.invocationId,
      toolName: "agent.invoke",
      args: {
        calleeSpecId: input.calleeSpecId,
        calleeLabel: toRole,
        goal: input.goal.slice(0, 500),
      },
    });
    await recordCoreMonitorToolStart({
      workflowId: input.workflowRunId,
      runId,
      toolCallId: input.invocationId,
      toolName: "agent.invoke",
      args: {
        calleeSpecId: input.calleeSpecId,
        calleeLabel: toRole,
        goal: input.goal.slice(0, 500),
      },
    });

    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: input.callerRole ?? "orchestrator",
      toRole,
      kind: "tool_call",
      toolKind: "prime_invoke",
      toolName: "agent.invoke",
      contentText: input.goal.slice(0, 2000),
      payloadJson: {
        backend: "rust",
        invocationId: input.invocationId,
        calleeSpecId: input.calleeSpecId,
        childSessionId: input.childSessionId,
        childTurnId: input.childTurnId,
        state,
        deliveryStatus: input.deliveryStatus,
      },
    });
  }

  if (input.startOnly || (!isTerminal && state === "running")) {
    return;
  }

  if (isTerminal) {
    await logResearchTeamInteraction({
      workflowRunId: input.workflowRunId,
      fromRole: toRole,
      toRole: input.callerRole ?? "orchestrator",
      kind: "llm_message",
      contentText: `invoke ${state}: ${input.goal.slice(0, 500)}`,
      payloadJson: {
        backend: "rust",
        phase: "prime_invoke_result",
        invocationId: input.invocationId,
        deliveryStatus: input.deliveryStatus,
      },
    });
  }

  const invokeOk =
    state !== "failed" && state !== "cancelled" && state !== "timed_out";
  publishCoreToolCallEnd(activityCtx, {
    toolCallId: input.invocationId,
    toolName: "agent.invoke",
    ok: invokeOk,
    status: invokeOk ? "success" : "failed",
    observation: {
      summary: `invoke ${state} → ${toRole}`,
      childSessionId: input.childSessionId,
      deliveryStatus: input.deliveryStatus,
    },
  });
  await recordCoreMonitorToolCall({
    workflowId: input.workflowRunId,
    runId,
    toolCallId: input.invocationId,
    toolName: "agent.invoke",
    ok: invokeOk,
    args: {
      calleeSpecId: input.calleeSpecId,
      calleeLabel: toRole,
    },
    observation: {
      summary: `invoke ${state} → ${toRole}`,
      childSessionId: input.childSessionId,
      deliveryStatus: input.deliveryStatus,
    },
  });
}

export type CoreInvocationWire = {
  request?: {
    invocation_id?: string;
    callee_spec_id?: string;
    goal?: string;
  };
  child_session_id?: string;
  child_turn_id?: string;
  state?: string;
  delivery?: { status?: string };
};

/**
 * Diff Core session.invocations against a local cursor and project new/updated
 * records into Bun UI (covers in-Core L0 `agent.invoke`, not only Bun RPC).
 */
export async function projectCoreInvocationsFromSnapshot(input: {
  workflowRunId: string;
  runId: string;
  traceId: string;
  callerRole?: string;
  invocations: unknown;
  /** Mutated: invocation_id → last projected state */
  projected: Map<string, string>;
}): Promise<void> {
  if (!Array.isArray(input.invocations)) return;
  for (const raw of input.invocations) {
    if (!raw || typeof raw !== "object") continue;
    const inv = raw as CoreInvocationWire;
    const invocationId = inv.request?.invocation_id?.trim();
    const calleeSpecId = inv.request?.callee_spec_id?.trim();
    const goal = inv.request?.goal?.trim() ?? "";
    if (!invocationId || !calleeSpecId) continue;
    const state = (inv.state ?? "unknown").toLowerCase();
    const prev = input.projected.get(invocationId);
    if (prev === state) continue;

    const isRunning = state === "running";
    const alreadyStarted = prev != null;

    await projectCoreInvocation({
      workflowRunId: input.workflowRunId,
      runId: input.runId,
      traceId: input.traceId,
      callerRole: input.callerRole,
      calleeSpecId,
      goal: goal || `invoke ${calleeSpecId}`,
      invocationId,
      childSessionId: inv.child_session_id,
      childTurnId: inv.child_turn_id,
      state,
      deliveryStatus: inv.delivery?.status,
      ...(isRunning
        ? { startOnly: true }
        : alreadyStarted
          ? { endOnly: true }
          : {}),
    });
    input.projected.set(invocationId, state);
  }
}

