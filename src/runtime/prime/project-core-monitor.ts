/**
 * Align Prime Core turns with Bun Monitor fact tables:
 *   agent_instance / agent_step / tool_call_log / llm_call_log
 *
 * Failures are swallowed (warn) so observability never blocks the turn.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentDefinition, agentInstance, agentStep } from "../../db/sqlite/schema";
import { writeLlmCallLog } from "../monitor/llm-call-logger";
import {
  recordToolCallError,
  recordToolCallStart,
  recordToolCallSuccess,
} from "../tools/tool-call-log-service";

export type CoreMonitorHandle = {
  workflowId: string;
  runId: string;
  traceId: string;
  role: string;
  agentDefinitionId: string;
  agentInstanceId: string;
  reasonStepId: string;
  actStepId: string;
  startedAtMs: number;
  /** toolCallId → start ms */
  openTools: Map<string, number>;
};

const handles = new Map<string, CoreMonitorHandle>();

function handleKey(workflowId: string, runId: string): string {
  return `${workflowId}::${runId}`;
}

export function getCoreMonitorHandle(workflowId: string, runId: string): CoreMonitorHandle | null {
  return handles.get(handleKey(workflowId, runId)) ?? null;
}

export function clearCoreMonitorHandle(workflowId: string, runId: string): void {
  handles.delete(handleKey(workflowId, runId));
}

async function resolveDefinitionId(role: string): Promise<string> {
  try {
    const db = await getDb();
    const rows = await db
      .select({ id: agentDefinition.id })
      .from(agentDefinition)
      .where(eq(agentDefinition.role, role as never))
      .limit(1);
    if (rows[0]?.id) return rows[0].id;
  } catch (err) {
    console.warn(
      "[prime-monitor] resolveDefinitionId failed:",
      err instanceof Error ? err.message : err
    );
  }
  // Stable fallback matching seed primary / orchestrator id convention
  if (role === "orchestrator") return "def-orchestrator";
  return `def-${role.replace(/_/g, "-")}`;
}

/**
 * Open a monitor scope for a Core turn: workflow-scoped agent_instance +
 * reason/act skeleton steps (same shape ReAct uses for quality joins).
 */
export async function beginCoreMonitorTurn(input: {
  workflowId: string;
  runId: string;
  traceId: string;
  role?: string;
  turnId?: string;
}): Promise<CoreMonitorHandle> {
  const role = input.role?.trim() || "orchestrator";
  const key = handleKey(input.workflowId, input.runId);
  const existing = handles.get(key);
  if (existing) return existing;

  const agentDefinitionId = await resolveDefinitionId(role);
  const agentInstanceId = randomUUID();
  const reasonStepId = randomUUID();
  const actStepId = randomUUID();
  const nowIso = new Date().toISOString();

  try {
    const db = await getDb();
    const prior = await db
      .select({ id: agentInstance.id })
      .from(agentInstance)
      .where(
        and(
          eq(agentInstance.workflowRunId, input.workflowId),
          eq(agentInstance.definitionId, agentDefinitionId),
          eq(agentInstance.status, "running")
        )
      )
      .limit(1);

    let instanceId = prior[0]?.id;
    if (instanceId) {
      await db
        .update(agentInstance)
        .set({ status: "running", errorMessage: null, endedAt: null })
        .where(eq(agentInstance.id, instanceId));
    } else {
      instanceId = agentInstanceId;
      await db.insert(agentInstance).values({
        id: instanceId,
        definitionId: agentDefinitionId,
        workflowRunId: input.workflowId,
        status: "running",
        currentIteration: 0,
        startedAt: nowIso,
      });
    }

    await db.insert(agentStep).values({
      id: reasonStepId,
      agentInstanceId: instanceId,
      workflowRunId: input.workflowId,
      stepIndex: 0,
      phase: "reason",
      // Empty thought — UI must not surface monitor placeholders as chat bubbles.
      thought: null,
      actionType: "final_answer",
      actionJson: {
        backend: "rust",
        phase: "prime_core_reason",
        runId: input.runId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        uiHiddenThought: true,
      },
    });
    await db.insert(agentStep).values({
      id: actStepId,
      agentInstanceId: instanceId,
      workflowRunId: input.workflowId,
      stepIndex: 1,
      phase: "act",
      thought: null,
      actionType: "tool_call",
      actionJson: {
        backend: "rust",
        phase: "prime_core_act",
        runId: input.runId,
        uiHiddenThought: true,
      },
    });

    const handle: CoreMonitorHandle = {
      workflowId: input.workflowId,
      runId: input.runId,
      traceId: input.traceId,
      role,
      agentDefinitionId,
      agentInstanceId: instanceId,
      reasonStepId,
      actStepId,
      startedAtMs: Date.now(),
      openTools: new Map(),
    };
    handles.set(key, handle);
    return handle;
  } catch (err) {
    console.warn(
      "[prime-monitor] beginCoreMonitorTurn failed:",
      err instanceof Error ? err.message : err
    );
    // Soft handle so callers can still proceed without DB rows
    const soft: CoreMonitorHandle = {
      workflowId: input.workflowId,
      runId: input.runId,
      traceId: input.traceId,
      role,
      agentDefinitionId,
      agentInstanceId,
      reasonStepId,
      actStepId,
      startedAtMs: Date.now(),
      openTools: new Map(),
    };
    handles.set(key, soft);
    return soft;
  }
}

export type CoreMonitorMcpMeta = {
  serverName: string;
  toolName: string;
  arguments?: unknown;
  transport?: string | null;
};

export async function recordCoreMonitorToolCall(input: {
  workflowId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  ok: boolean;
  args?: Record<string, unknown>;
  observation?: unknown;
  latencyMs?: number;
  /** When set, also writes mcp_call_log (Core MCP via L2 bridge). */
  mcp?: CoreMonitorMcpMeta;
  /** Prefer looking up handle; if missing, no-op. */
}): Promise<void> {
  const handle = getCoreMonitorHandle(input.workflowId, input.runId);
  if (!handle) return;

  const mcp = input.mcp;
  const hasMcp = Boolean(mcp);
  const toolKind = hasMcp ? ("mcp" as const) : ("builtin" as const);
  const targetKind = hasMcp ? ("mcp" as const) : ("tool" as const);

  const started = handle.openTools.get(input.toolCallId) ?? Date.now();
  if (!handle.openTools.has(input.toolCallId)) {
    handle.openTools.set(input.toolCallId, started);
    try {
      await recordToolCallStart({
        toolCallId: input.toolCallId,
        agentStepId: handle.actStepId,
        workflowRunId: handle.workflowId,
        traceId: handle.traceId,
        agentDefinitionId: handle.agentDefinitionId,
        targetName: input.toolName,
        toolKind,
        targetKind,
        ...(mcp
          ? {
              mcp: {
                serverName: mcp.serverName,
                toolName: mcp.toolName,
                ...(mcp.arguments !== undefined ? { arguments: mcp.arguments } : {}),
              },
              mcpTransport: mcp.transport ?? null,
            }
          : {}),
        reasonText: `prime_core:${input.toolName}`,
        contextMemory: {
          backend: "rust",
          args: input.args ?? null,
        },
      });
    } catch (err) {
      console.warn(
        "[prime-monitor] recordToolCallStart failed:",
        err instanceof Error ? err.message : err
      );
      return;
    }
  }

  const latencyMs = Math.max(1, input.latencyMs ?? Date.now() - started);
  handle.openTools.delete(input.toolCallId);

  try {
    if (input.ok) {
      const payload =
        input.observation && typeof input.observation === "object"
          ? (input.observation as Record<string, unknown>)
          : { summary: String(input.observation ?? "ok") };
      await recordToolCallSuccess({
        toolCallId: input.toolCallId,
        hasMcp,
        latencyMs,
        responsePayload: { backend: "rust", ...payload },
      });
    } else {
      const message =
        input.observation &&
        typeof input.observation === "object" &&
        "summary" in (input.observation as object)
          ? (() => {
              const s = (input.observation as { summary?: unknown }).summary;
              if (typeof s === "string") return s || "failed";
              if (s == null) return "failed";
              try {
                return JSON.stringify(s).slice(0, 500);
              } catch {
                return "failed";
              }
            })()
          : typeof input.observation === "string"
            ? input.observation
            : "prime_core_tool_failed";
      await recordToolCallError({
        toolCallId: input.toolCallId,
        hasMcp,
        latencyMs,
        errorSource: hasMcp ? "mcp" : "builtin",
        errorMessage: message.slice(0, 2000),
      });
    }
  } catch (err) {
    console.warn(
      "[prime-monitor] finalize tool_call_log failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/** Mark tool start without finishing (for Running invokes). */
export async function recordCoreMonitorToolStart(input: {
  workflowId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  mcp?: CoreMonitorMcpMeta;
}): Promise<void> {
  const handle = getCoreMonitorHandle(input.workflowId, input.runId);
  if (!handle || handle.openTools.has(input.toolCallId)) return;
  handle.openTools.set(input.toolCallId, Date.now());
  const mcp = input.mcp;
  const hasMcp = Boolean(mcp);
  try {
    await recordToolCallStart({
      toolCallId: input.toolCallId,
      agentStepId: handle.actStepId,
      workflowRunId: handle.workflowId,
      traceId: handle.traceId,
      agentDefinitionId: handle.agentDefinitionId,
      targetName: input.toolName,
      toolKind: hasMcp ? "mcp" : "builtin",
      targetKind: hasMcp ? "mcp" : "tool",
      ...(mcp
        ? {
            mcp: {
              serverName: mcp.serverName,
              toolName: mcp.toolName,
              ...(mcp.arguments !== undefined ? { arguments: mcp.arguments } : {}),
            },
            mcpTransport: mcp.transport ?? null,
          }
        : {}),
      reasonText: `prime_core:${input.toolName}`,
      contextMemory: {
        backend: "rust",
        args: input.args ?? null,
      },
    });
  } catch (err) {
    console.warn(
      "[prime-monitor] recordCoreMonitorToolStart failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function finalizeCoreMonitorTurn(input: {
  workflowId: string;
  runId: string;
  ok: boolean;
  turn?: {
    iteration?: number;
    answer_text?: string | null;
    llm_stats?: {
      sample_count?: number;
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      total_tokens?: number | null;
      latency_ms?: number | null;
      model?: string | null;
      provider?: string | null;
    } | null;
  } | null;
}): Promise<void> {
  const handle = getCoreMonitorHandle(input.workflowId, input.runId);
  if (!handle) return;

  const stats = input.turn?.llm_stats;
  const latencyMs =
    typeof stats?.latency_ms === "number" && stats.latency_ms > 0
      ? Math.floor(stats.latency_ms)
      : Math.max(1, Date.now() - handle.startedAtMs);
  const sampleCount = Math.max(1, Math.floor(stats?.sample_count ?? 1));

  try {
    await writeLlmCallLog({
      workflowRunId: handle.workflowId,
      agentStepId: handle.reasonStepId,
      agentDefinitionId: handle.agentDefinitionId,
      provider: stats?.provider?.trim() ? stats.provider.trim() : "prime_core",
      model: stats?.model?.trim() || "unknown",
      usage: {
        ...(typeof stats?.prompt_tokens === "number" ? { promptTokens: stats.prompt_tokens } : {}),
        ...(typeof stats?.completion_tokens === "number"
          ? { completionTokens: stats.completion_tokens }
          : {}),
        ...(typeof stats?.total_tokens === "number" ? { totalTokens: stats.total_tokens } : {}),
      },
      latencyMs,
      status: input.ok ? "success" : "error",
      ...(input.ok ? {} : { errorMessage: "prime_core_turn_failed" }),
      systemPromptLen: undefined,
      userPromptLen: undefined,
      extraMeta: {
        backend: "rust",
        sampleCount,
        iteration: input.turn?.iteration ?? null,
        runId: handle.runId,
      },
    });
  } catch (err) {
    console.warn(
      "[prime-monitor] writeLlmCallLog failed:",
      err instanceof Error ? err.message : err
    );
  }

  try {
    const db = await getDb();
    await db
      .update(agentStep)
      .set({
        tokenCount: typeof stats?.total_tokens === "number" ? stats.total_tokens : null,
        latencyMs,
        observationJson: {
          backend: "rust",
          answerChars: input.turn?.answer_text?.length ?? 0,
          llm_stats: stats ?? null,
        },
      })
      .where(eq(agentStep.id, handle.reasonStepId));

    await db
      .update(agentInstance)
      .set({
        status: input.ok ? "idle" : "error",
        currentIteration: Math.max(0, Math.floor(input.turn?.iteration ?? sampleCount)),
        endedAt: new Date().toISOString(),
        ...(input.ok ? {} : { errorMessage: "prime_core_turn_failed" }),
      })
      .where(eq(agentInstance.id, handle.agentInstanceId));
  } catch (err) {
    console.warn(
      "[prime-monitor] finalize steps/instance failed:",
      err instanceof Error ? err.message : err
    );
  }

  clearCoreMonitorHandle(input.workflowId, input.runId);
}
