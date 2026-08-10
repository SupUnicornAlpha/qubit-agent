/**
 * Orchestrator TASK_ASSIGN → Rust Core turn (QUBIT_CORE_BACKEND=rust).
 * Covers orchestrator_chat / workflow_resume|retry / default task types.
 */

import { randomUUID } from "node:crypto";
import type { A2AMessageEnvelope, TaskAssignPayload } from "../../types/a2a";
import { resolveAgentControlMode } from "../../types/loop";
import { completeA2ATask, markA2ATaskWorking } from "../a2a/a2a-task-service";
import { buildTaskResult } from "../a2a/task-result";
import { onWorkflowTerminal } from "../monitor/observability-hook";
import { stepStreamBus } from "../react/event-stream";
import type { RuntimeHandlerContext } from "../types";
import { createHitlRequest, loadWorkflowLoopContext } from "../workflow/hitl-service";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import { clearPrimeBridgeRunContext, setPrimeBridgeRunContext } from "./bridge-run-context";
import { buildCoreHitlClientMeta } from "./core-hitl-bridge";
import { asRustCoreClient, ensureCoreSession } from "./ensure-core-session";
import { resolveCoreBackend } from "./core-runtime";
import {
  finalizeCorePlanForCompletedWorkflow,
  syncCorePlanToWorkflow,
} from "./project-core-activity";
import { beginCoreMonitorTurn, finalizeCoreMonitorTurn } from "./project-core-monitor";
import {
  projectCoreInvocationsFromSnapshot,
  projectCoreTurnResult,
  sanitizeCoreAnswerText,
} from "./project-core-to-graph";
import { persistDeliveryVerdictForCoreTurn } from "./persist-core-delivery";
import type { InteractionMode, SessionSnapshot } from "./types";
import { ORCHESTRATOR_TURN_CONTEXT } from "./types";
import { completeWorkflowConversationAssistant } from "../conversation/conversation-projection";

/** Long-running multi-agent research routinely exceeds five minutes. */
const DEFAULT_PRIME_TURN_TIMEOUT_MS = 15 * 60_000;

export {
  shouldPauseCoreTurnForChatHitl,
  buildCoreHitlClientMeta,
} from "./core-hitl-bridge";

function resolveExecutionRunId(payload: TaskAssignPayload): string {
  return payload.executionRunId?.trim() || randomUUID();
}

function mapInteractionMode(raw: unknown): InteractionMode {
  return resolveAgentControlMode(raw);
}

/** Build Core UserInput.text from A2A task params (chat / resume / generic). */
export function buildCoreUserText(input: {
  taskType: string;
  params: Record<string, unknown>;
  workflowGoal?: string;
  /**
   * When true, omit params.context from the user text — Host must pass it via
   * `turn.start.context.session_chronicle` (P3 authority split).
   */
  omitContext?: boolean;
}): string {
  const params = input.params;
  const goal =
    (typeof params.goal === "string" && params.goal.trim()) || (input.workflowGoal?.trim() ?? "");
  const context =
    input.omitContext === true
      ? ""
      : typeof params.context === "string"
        ? params.context.trim()
        : "";
  const parts: string[] = [];

  if (
    input.taskType === "workflow_resume" ||
    input.taskType === "workflow_retry" ||
    params.hitlApproval
  ) {
    parts.push(`[task_type]\n${input.taskType}`);
    if (params.resume === true) parts.push("[resume]\nsnapshot_resume=true");
    if (params.hitlApproval && typeof params.hitlApproval === "object") {
      parts.push(`[hitl_approval]\n${JSON.stringify(params.hitlApproval, null, 2)}`);
    }
    if (params.hitlPayload && typeof params.hitlPayload === "object") {
      parts.push(`[hitl_payload]\n${JSON.stringify(params.hitlPayload, null, 2)}`);
    }
    if (typeof params.primeCoreInboxId === "string" && params.primeCoreInboxId) {
      parts.push(`[prime_core_inbox]\ninbox_id=${params.primeCoreInboxId}`);
    }
    parts.push(
      "[instruction]\nContinue the interrupted turn. The [user] block is the AUTHORITATIVE " +
        "user request that must still be fulfilled (including symbol/target clarifications). " +
        "Reuse prior tool observations and do not re-fetch identical MCP evidence unless necessary. " +
        "Produce the next user-facing answer."
    );
    if (typeof params.resumeSource === "string" && params.resumeSource) {
      parts.push(`[resume_source]\n${params.resumeSource}`);
    }
  }

  // Legacy path: chronicle still embedded when omitContext is false.
  if (context) {
    const alreadyMarked = context.includes("OPTIONAL_BACKGROUND");
    parts.push(
      alreadyMarked
        ? `[session_chronicle]\n${context}`
        : `[session_chronicle]\nOPTIONAL_BACKGROUND — do NOT override the [user] task:\n${context}`
    );
  }
  if (goal) parts.push(`[user]\n${goal}`);
  if (parts.length === 0) {
    return goal || context || `(task ${input.taskType})`;
  }
  return parts.join("\n\n");
}

function publishStreamFrames(input: {
  runId: string;
  workflowId: string;
  traceId: string;
  text: string;
  ok: boolean;
  awaitingHitl?: boolean;
}): void {
  const base = {
    runId: input.runId,
    workflowId: input.workflowId,
    traceId: input.traceId,
    role: "orchestrator",
    stepIndex: 0,
    ts: Date.now(),
    loopKind: "native" as const,
    source: "a2a" as const,
  };
  if (input.awaitingHitl) {
    stepStreamBus.publish({
      ...base,
      type: "hitl_request",
      payload: { text: input.text, backend: "rust" },
    });
    stepStreamBus.close(input.runId);
    return;
  }
  if (input.text) {
    stepStreamBus.publish({
      ...base,
      type: "token",
      payload: { text: input.text, backend: "rust" },
    });
  }
  stepStreamBus.publish({
    ...base,
    type: input.ok ? "final" : "error",
    payload: input.ok
      ? { answerText: input.text, backend: "rust" }
      : { error: input.text || "prime_core_turn_failed", backend: "rust" },
  });
  stepStreamBus.close(input.runId);
}

async function projectCoreAwaitingHitl(input: {
  workflowId: string;
  runId: string;
  traceId: string;
  sessionId: string;
  turnId: string;
  snap: SessionSnapshot;
}): Promise<{ inboxId: string; title: string; body: string } | null> {
  const client = asRustCoreClient();
  const inbox = await client.hitlInboxList({
    session_id: input.sessionId,
    pending_only: true,
  });
  const item = inbox.find((i) => i.turn_id === input.turnId) ?? inbox[0];
  if (!item) return null;

  const title = item.prompt?.title || "Prime Core 需要审批";
  const body = item.prompt?.body || "请审批后继续。";
  const promptExtra = item.prompt as
    | {
        title?: string;
        body?: string;
        input_kind?: string;
        options?: Array<{ id: string; label: string }>;
      }
    | undefined;
  const inputKind =
    promptExtra?.input_kind === "single_choice" ||
    promptExtra?.input_kind === "multi_choice" ||
    promptExtra?.input_kind === "free_form"
      ? promptExtra.input_kind
      : "approve_only";
  const inputSchema =
    Array.isArray(promptExtra?.options) && promptExtra.options.length > 0
      ? {
          options: promptExtra.options.map((o) => ({
            label: o.label,
            value: o.id,
          })),
        }
      : {};
  await createHitlRequest({
    workflowRunId: input.workflowId,
    runId: input.runId,
    traceId: input.traceId,
    role: "orchestrator",
    stepIndex: 0,
    scope: "chat_orchestrator",
    requestKind: "user_question",
    title,
    summary: body,
    payloadJson: {
      backend: "rust",
      primeCoreInboxId: item.inbox_id,
      primeCoreSessionId: input.sessionId,
      primeCoreTurnId: input.turnId,
      source: "prime_core_hitl",
    },
    inputKind,
    inputSchema,
  });
  return { inboxId: item.inbox_id, title, body };
}

export type CoreTaskResult =
  | {
      finalResponse: Record<string, unknown>;
      terminalStatus: "completed" | "partial" | "failed" | "awaiting_approval";
    }
  | undefined;

/**
 * Generic orchestrator task on Rust Core + Bun projection surfaces.
 */
export async function runOrchestratorTaskViaCore(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload
): Promise<CoreTaskResult> {
  if (resolveCoreBackend() !== "rust") {
    throw new Error("runOrchestratorTaskViaCore requires QUBIT_CORE_BACKEND=rust");
  }

  const params = (payload.params ?? {}) as Record<string, unknown>;
  const runId = resolveExecutionRunId(payload);
  const conversationTurnId =
    typeof params.conversationTurnId === "string" && params.conversationTurnId.trim()
      ? params.conversationTurnId.trim()
      : undefined;
  const { workflow, loopOptions } = await loadWorkflowLoopContext(msg.workflowId);
  const sessionChronicle =
    typeof params.context === "string" && params.context.trim() ? params.context.trim() : undefined;
  // P3: authoritative user text only in input.text; chronicle via context.session_chronicle.
  const text = buildCoreUserText({
    taskType: payload.taskType,
    params,
    workflowGoal: workflow.goal,
    omitContext: true,
  });
  const turnContext = {
    ...ORCHESTRATOR_TURN_CONTEXT,
    ...(sessionChronicle ? { session_chronicle: sessionChronicle } : {}),
  };
  const interactionMode = mapInteractionMode({
    ...loopOptions,
    ...(typeof params.agentMode === "string" ? { agentMode: params.agentMode } : {}),
  });

  const startedAt = Date.now();
  await markA2ATaskWorking(payload.taskId);
  await setWorkflowState(msg.workflowId, "running", { reason: "prime-core-task" });

  // If Bun HITL carried a Core inbox id, acknowledge it before the next turn.
  const coreInboxId =
    typeof params.primeCoreInboxId === "string"
      ? params.primeCoreInboxId
      : typeof (params.hitlPayload as Record<string, unknown> | undefined)?.primeCoreInboxId ===
          "string"
        ? String((params.hitlPayload as Record<string, unknown>).primeCoreInboxId)
        : null;
  if (coreInboxId && params.hitlApproval) {
    const approval = params.hitlApproval as { decision?: string };
    try {
      await asRustCoreClient().hitlRespond({
        inbox_id: coreInboxId,
        approved: approval.decision !== "rejected",
        free_form:
          typeof approval === "object" ? JSON.stringify(approval).slice(0, 2000) : undefined,
      });
    } catch (err) {
      console.warn(
        "[prime-core] hitl.respond failed (continuing with resume turn):",
        err instanceof Error ? err.message : err
      );
    }
  }

  const activityCtx = {
    workflowId: msg.workflowId,
    runId,
    traceId: msg.traceId,
    role: "orchestrator",
  };

  try {
    const { sessionId } = await ensureCoreSession({
      workflowId: msg.workflowId,
      interactionMode,
    });
    setPrimeBridgeRunContext({
      ...activityCtx,
      sessionId,
    });
    const client = asRustCoreClient();
    let started: { turn_id: string };
    let snap!: SessionSnapshot;
    let lastPlanKey = "";
    const projectedInvokes = new Map<string, string>();
    try {
      const approval = params.hitlApproval as { decision?: string } | undefined;
      const skipToolGateOnce = approval?.decision === "approved";
      // Open correlation before turn.start: Core assembles memory/Skills while
      // starting the turn, so opening the monitor afterwards loses Skill logs.
      await beginCoreMonitorTurn({
        workflowId: msg.workflowId,
        runId,
        traceId: msg.traceId,
        role: "orchestrator",
      });
      started = await client.startTurn({
        session_id: sessionId,
        input: {
          text,
          attachments: [],
          client_meta: buildCoreHitlClientMeta({
            loopOptions,
            ...(skipToolGateOnce ? { skipToolGateOnce: true } : {}),
          }),
        },
        idempotency_key:
          conversationTurnId ?? `${msg.workflowId}:${payload.taskId}:${randomUUID()}`,
        context: turnContext,
      });
      const configuredTimeoutMs = Number(
        loopOptions.timeoutMs ??
          process.env.QUBIT_PRIME_TURN_TIMEOUT_MS ??
          DEFAULT_PRIME_TURN_TIMEOUT_MS
      );
      const timeoutMs = Math.max(30_000, configuredTimeoutMs || DEFAULT_PRIME_TURN_TIMEOUT_MS);
      try {
        snap = await client.awaitTurnTerminal(
          sessionId,
          started.turn_id,
          timeoutMs,
          async (tick) => {
            if (tick.plan != null) {
              const key = JSON.stringify(tick.plan);
              if (key !== lastPlanKey) {
                lastPlanKey = key;
                await syncCorePlanToWorkflow(activityCtx, tick.plan);
              }
            }
            await projectCoreInvocationsFromSnapshot({
              workflowRunId: msg.workflowId,
              runId,
              traceId: msg.traceId,
              callerRole: "orchestrator",
              invocations: tick.invocations,
              projected: projectedInvokes,
            });
          },
          async (event) => {
            // Live Core reasoning → Team UI ThinkingGhostBox (not answer bubbles).
            if (event.type !== "reasoning_token") return;
            const piece = typeof event.text === "string" ? event.text : "";
            if (!piece) return;
            stepStreamBus.publish({
              runId,
              workflowId: msg.workflowId,
              traceId: msg.traceId,
              role: "orchestrator",
              type: "reasoning_token",
              stepIndex: typeof event.iteration === "number" ? event.iteration : 0,
              ts: Date.now(),
              loopKind: "native",
              source: "a2a",
              payload: { token: piece, backend: "rust" },
            });
          }
        );
      } catch (err) {
        // Best-effort: capture partial turn answer before cancel.
        try {
          snap = await client.sessionSnapshot(sessionId);
        } catch {
          /* ignore */
        }
        // A plan update may have reached Core immediately before the wait timed
        // out. Persist that snapshot before failing the turn, otherwise resume
        // starts from the old card state even though work already finished.
        if (snap?.plan != null) {
          try {
            await syncCorePlanToWorkflow(activityCtx, snap.plan, { announceToolCall: false });
          } catch (syncErr) {
            console.warn(
              "[prime-core] timeout plan snapshot sync failed:",
              syncErr instanceof Error ? syncErr.message : syncErr
            );
          }
        }
        try {
          if (typeof client.failTurn === "function") {
            await client.failTurn({
              session_id: sessionId,
              turn_id: started.turn_id,
            });
          } else {
            await client.cancelTurn({
              session_id: sessionId,
              turn_id: started.turn_id,
            });
          }
        } catch {
          try {
            await client.cancelTurn({
              session_id: sessionId,
              turn_id: started.turn_id,
            });
          } catch {
            /* ignore */
          }
        }
        const partialAnswer =
          typeof snap?.active_turn?.answer_text === "string"
            ? snap.active_turn.answer_text.trim()
            : "";
        const timeoutMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = /timeout waiting for turn/i.test(timeoutMsg);
        const handoffFallback = synthesizeHandoffsFromSnapshot(snap);
        const fallbackText =
          partialAnswer ||
          handoffFallback ||
          (isTimeout
            ? `${timeoutMsg}\n\n（可点击「从检查点继续」恢复；已保留子代理交付摘要。）`
            : timeoutMsg);
        await persistDeliveryVerdictForCoreTurn({
          workflowId: msg.workflowId,
          answerText: fallbackText,
          forceFailed: isTimeout || !partialAnswer,
          forceReason: isTimeout
            ? `prime_core_turn_timeout:${started.turn_id}`
            : `prime_core_turn_error:${timeoutMsg.slice(0, 120)}`,
        });
        await finalizeCoreMonitorTurn({
          workflowId: msg.workflowId,
          runId,
          ok: false,
          turn: snap?.active_turn ?? null,
        });
        // Keep partial text in the delivery/checkpoint stores for resume, but
        // never project it as a user-facing final answer. Resume would then
        // project the complete answer again, visibly duplicating the report.
        throw err;
      }
    } finally {
      clearPrimeBridgeRunContext({ workflowId: msg.workflowId, runId });
    }

    // Final plan + invoke sync (in case last tick raced before terminal)
    if (snap.plan != null) {
      await syncCorePlanToWorkflow(activityCtx, snap.plan, {
        announceToolCall: false,
      });
    }
    await projectCoreInvocationsFromSnapshot({
      workflowRunId: msg.workflowId,
      runId,
      traceId: msg.traceId,
      callerRole: "orchestrator",
      invocations: snap.invocations,
      projected: projectedInvokes,
    });

    const turn = snap.active_turn;

    if (turn?.state === "awaiting_hitl") {
      const projected = await projectCoreAwaitingHitl({
        workflowId: msg.workflowId,
        runId,
        traceId: msg.traceId,
        sessionId,
        turnId: started.turn_id,
        snap,
      });
      const hitlText = projected?.body || turn.answer_text || "等待人工审批（Prime Core）";
      await finalizeCoreMonitorTurn({
        workflowId: msg.workflowId,
        runId,
        ok: true,
        turn,
      });
      publishStreamFrames({
        runId,
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        text: hitlText,
        ok: true,
        awaitingHitl: true,
      });
      const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
        status: "awaiting_approval",
        errorCode: "awaiting_approval",
        errorMessage: "Prime Core 正在等待人工审批",
        result: {
          backend: "rust",
          sessionId,
          turnId: started.turn_id,
          primeCoreInboxId: projected?.inboxId,
        },
        durationMs: Date.now() - startedAt,
      });
      await completeA2ATask(payload.taskId, taskResultPayload);
      await ctx.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: msg.senderAgent,
        messageType: "TASK_RESULT",
        payload: taskResultPayload,
        priority: msg.priority,
      });
      return {
        finalResponse: {
          status: "awaiting_approval",
          answerText: hitlText,
          backend: "rust",
        },
        terminalStatus: "awaiting_approval",
      };
    }

    const answer = sanitizeCoreAnswerText(
      (typeof turn?.answer_text === "string" && turn.answer_text) || ""
    );
    const deliveryStatus = turn?.delivery?.status;
    const failed =
      turn?.state === "failed" ||
      turn?.state === "cancelled" ||
      deliveryStatus === "failed" ||
      deliveryStatus === "cancelled";
    const partial = deliveryStatus === "partial" || deliveryStatus === "delivered_with_gaps";
    const terminalStatus: "completed" | "partial" | "failed" = failed
      ? "failed"
        : partial
          ? "partial"
          : "completed";

    // Do not leave a completed resumed workflow visually stuck on the last
    // pending/in-progress plan item when the model omitted its final
    // `update_plan` call. A plan-mode turn only drafts work, so it must remain
    // pending; non-completed turns also intentionally keep their plan.
    if (terminalStatus === "completed" && interactionMode !== "plan") {
      try {
        await finalizeCorePlanForCompletedWorkflow(activityCtx);
      } catch (err) {
        // Plan is a UI projection; an artifact/SQLite hiccup must not turn a
        // successfully delivered Core answer into a failed workflow.
        console.warn(
          "[prime-core] terminal plan finalization failed:",
          err instanceof Error ? err.message : err
        );
      }
    }

    const displayText =
      answer ||
      (failed
        ? `Prime Core turn 失败：state=${turn?.state ?? "?"} delivery=${deliveryStatus ?? "n/a"}`
        : "（Prime Core 已完成，无文本）");

    await persistDeliveryVerdictForCoreTurn({
      workflowId: msg.workflowId,
      answerText: displayText,
    });

    await projectCoreTurnResult({
      workflowRunId: msg.workflowId,
      snap,
      fallbackText: displayText,
      ...(conversationTurnId ? { conversationTurnId } : {}),
      sourceTaskType: payload.taskType,
    });

    await finalizeCoreMonitorTurn({
      workflowId: msg.workflowId,
      runId,
      ok: !failed,
      turn,
    });

    publishStreamFrames({
      runId,
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      text: displayText,
      ok: !failed,
    });

    // Always close the chat assistant bubble — previously only the timeout/catch
    // path called this, so terminal-failed turns (orphan recover, Core restart)
    // left status=`running` forever in the UI.
    await completeWorkflowConversationAssistant({
      workflowRunId: msg.workflowId,
      content: displayText,
      status: failed ? "failed" : "completed",
      ...(failed ? { errorMessage: displayText.slice(0, 500) } : {}),
      ...(conversationTurnId ? { conversationTurnId } : {}),
    });

    const finalResponse: Record<string, unknown> = {
      answerText: displayText,
      status: terminalStatus,
      backend: "rust",
      sessionId,
      turnId: started.turn_id,
      delivery: turn?.delivery ?? null,
      goal: typeof params.goal === "string" ? params.goal : workflow.goal,
      taskType: payload.taskType,
    };

    await setWorkflowState(msg.workflowId, terminalStatus, {
      reason: "prime-core-task",
    });
    onWorkflowTerminal(msg.workflowId, terminalStatus);

    const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
      status:
        terminalStatus === "completed"
          ? "completed"
          : terminalStatus === "partial"
            ? "partial"
            : "failed",
      success: terminalStatus === "completed",
      result: finalResponse,
      ...(terminalStatus !== "completed"
        ? {
            errorCode: "prime_core_turn",
            errorMessage: displayText.slice(0, 500),
          }
        : {}),
      summary: displayText.slice(0, 500),
      durationMs: Date.now() - startedAt,
    });
    await completeA2ATask(payload.taskId, taskResultPayload);
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: taskResultPayload,
      priority: msg.priority,
    });

    return { finalResponse, terminalStatus };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = /timeout waiting for turn/i.test(message);
    await finalizeCoreMonitorTurn({
      workflowId: msg.workflowId,
      runId,
      ok: false,
      turn: null,
    });
    publishStreamFrames({
      runId,
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      text: isTimeout
        ? `${message}\n\n（可点击「从检查点继续」恢复；已保留会话与工具观察。）`
        : message,
      ok: false,
    });
    // Timeout → partial so UI can offer Cursor-style resume; hard errors stay failed.
    const terminalStatus = isTimeout ? "partial" : "failed";
    await setWorkflowState(msg.workflowId, terminalStatus, {
      reason: isTimeout ? "prime-core-timeout-resumable" : "prime-core-task",
    });
    onWorkflowTerminal(msg.workflowId, terminalStatus);
    const taskResultPayload = buildTaskResult(payload.taskId, ctx.definition.role, {
      status: terminalStatus === "partial" ? "partial" : "failed",
      success: false,
      errorCode: isTimeout ? "prime_core_timeout" : "prime_core_error",
      errorMessage: message,
      result: {
        resumable: isTimeout,
        resumeHint: isTimeout ? "checkpoint" : undefined,
      },
      durationMs: Date.now() - startedAt,
    });
    await completeA2ATask(payload.taskId, taskResultPayload);
    await ctx.send({
      workflowId: msg.workflowId,
      traceId: msg.traceId,
      receiverAgent: msg.senderAgent,
      messageType: "TASK_RESULT",
      payload: taskResultPayload,
      priority: msg.priority,
    });
    await completeWorkflowConversationAssistant({
      workflowRunId: msg.workflowId,
      content: isTimeout
        ? `${message}\n\n（可点击「从检查点继续」恢复；已保留会话与工具观察。）`
        : message,
      status: "failed",
      errorMessage: isTimeout ? "prime_core_timeout" : message.slice(0, 500),
      ...(conversationTurnId ? { conversationTurnId } : {}),
    });
    return undefined;
  }
}

function synthesizeHandoffsFromSnapshot(snap: SessionSnapshot | null | undefined): string {
  const inv = snap?.invocations;
  if (!Array.isArray(inv) || inv.length === 0) return "";
  const parts: string[] = ["## 超时前子代理交付摘要"];
  for (const row of inv) {
    const rec = row as {
      request?: { callee_spec_id?: string };
      handoff_out?: { narrative?: string | null };
      state?: string;
    };
    const callee = rec.request?.callee_spec_id ?? "?";
    const narrative = (rec.handoff_out?.narrative ?? "").trim();
    if (!narrative) continue;
    parts.push(`### ${callee} (${rec.state ?? "?"})\n${narrative.slice(0, 1200)}`);
  }
  return parts.length > 1 ? parts.join("\n\n").slice(0, 6000) : "";
}

/** @deprecated Prefer runOrchestratorTaskViaCore — kept for call sites. */
export async function runOrchestratorChatViaCore(
  ctx: RuntimeHandlerContext,
  msg: A2AMessageEnvelope,
  payload: TaskAssignPayload
): Promise<CoreTaskResult> {
  return runOrchestratorTaskViaCore(ctx, msg, payload);
}
