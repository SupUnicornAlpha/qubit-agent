import { getDb } from "../../../db/sqlite/client";
import { acpCall, toolCallLog } from "../../../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { sandboxExecutor } from "../../sandbox-executor";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { runAnalystTeam } from "../../msa/analyst-team";

/** Extract tool name and params from LLM reason text */
function extractToolCall(reasonText: string, availableTools: string[]): { toolName: string; params: Record<string, unknown> } {
  // Try to parse JSON tool call from reason text
  try {
    const match = reasonText.match(/\{[\s\S]*"tool"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const toolName = typeof parsed["tool"] === "string" ? parsed["tool"] : "";
      if (toolName && availableTools.includes(toolName)) {
        const params = (parsed["params"] ?? parsed["parameters"] ?? {}) as Record<string, unknown>;
        return { toolName, params };
      }
    }
  } catch {
    // fall through
  }
  // Try to find tool name mentioned in text
  for (const tool of availableTools) {
    if (reasonText.includes(tool)) {
      return { toolName: tool, params: {} };
    }
  }
  return { toolName: availableTools[0] ?? "noop_tool", params: {} };
}

export async function actNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string,
  agentStepId: string
): Promise<Partial<AgentGraphState>> {
  const { toolName, params: toolParams } = extractToolCall(
    state.reasonText ?? "",
    state.agentDefinition.tools
  );
  const toolCallId = crypto.randomUUID();
  const db = await getDb();

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_start",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, toolName },
  });

  await db.insert(toolCallLog).values({
    id: toolCallId,
    agentStepId,
    toolName,
    toolKind: "builtin",
    requestJson: {
      reasonText: state.reasonText,
      contextMemory: state.contextMemory,
    },
    status: "success",
    latencyMs: 1,
  });

  const check = await sandboxExecutor.checkToolCall({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentInstanceId,
    toolName,
    payload: { plannedAction: state.plannedAction ?? "unknown" },
    definition: state.agentDefinition,
  });

  if (!check.allowed) {
    const acpId = crypto.randomUUID();
    await db.insert(acpCall).values({
      id: acpId,
      workflowRunId: state.workflowId,
      traceId: state.traceId,
      agentStepId,
      callerInstanceId: agentInstanceId,
      targetKind: "tool",
      targetName: toolName,
      intent: state.plannedAction ?? "tool_call",
      status: "blocked_by_sandbox",
      errorCode: check.violationType ?? "tool_not_allowed",
    });

    await db
      .update(toolCallLog)
      .set({
        status: "sandbox_blocked",
        errorMessage: check.reason ?? "blocked by sandbox",
      })
      .where(eq(toolCallLog.id, toolCallId));

    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_call_end",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolCallId, status: "blocked_by_sandbox", reason: check.reason },
    });
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        level: "error",
        sandbox: true,
        acpId,
        reason: check.reason ?? "sandbox denied tool call",
      },
    });

    return {
      toolCalls: [
        ...state.toolCalls,
        { toolCallId, toolName, status: "blocked_by_sandbox", reason: check.reason },
      ],
      observations: [
        ...state.observations,
        { level: "error", message: check.reason ?? "sandbox denied tool call" },
      ],
    };
  }

  const startedAt = Date.now();
  const execution = await sandboxExecutor.enforceToolTimeout({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentInstanceId,
    definition: state.agentDefinition,
    action: async () => {
      // V2: dispatch run_analyst_team tool
      if (toolName === "run_analyst_team") {
        const ticker = (toolParams["ticker"] as string) ||
          (state.inboundMessage.payload as Record<string, unknown>)?.["ticker"] as string ||
          extractTickerFromText(state.reasonText ?? "") ||
          "UNKNOWN";
        const context = (toolParams["context"] as string) ||
          (state.inboundMessage.payload as Record<string, unknown>)?.["goal"] as string ||
          undefined;

        const teamResult = await runAnalystTeam({
          workflowRunId: state.workflowId,
          ticker,
          context,
        });
        return { result: "ok" as const, analystTeamResult: teamResult };
      }
      await Bun.sleep(1);
      return { result: "ok" as const };
    },
    meta: { toolName },
  });

  if (!execution.ok) {
    const latencyMs = Date.now() - startedAt;
    const timeoutAcpId = crypto.randomUUID();
    await db.insert(acpCall).values({
      id: timeoutAcpId,
      workflowRunId: state.workflowId,
      traceId: state.traceId,
      agentStepId,
      callerInstanceId: agentInstanceId,
      targetKind: "tool",
      targetName: toolName,
      intent: state.plannedAction ?? "tool_call",
      status: "timeout",
      latencyMs,
      errorCode: execution.result.violationType ?? "timeout",
    });
    await db
      .update(toolCallLog)
      .set({
        status: "timeout",
        latencyMs,
        errorMessage: execution.result.reason ?? "tool timeout",
      })
      .where(eq(toolCallLog.id, toolCallId));
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_call_end",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolCallId, status: "timeout", reason: execution.result.reason },
    });
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { level: "error", timeout: true, reason: execution.result.reason },
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        { toolCallId, toolName, status: "timeout", reason: execution.result.reason },
      ],
      observations: [
        ...state.observations,
        { level: "error", message: execution.result.reason ?? "tool timeout" },
      ],
    };
  }

  const latencyMs = Date.now() - startedAt;
  const acpId = crypto.randomUUID();
  await db.insert(acpCall).values({
    id: acpId,
    workflowRunId: state.workflowId,
    traceId: state.traceId,
    agentStepId,
    callerInstanceId: agentInstanceId,
    targetKind: "tool",
    targetName: toolName,
    intent: state.plannedAction ?? "tool_call",
    status: "success",
    latencyMs,
  });

  await db
    .update(toolCallLog)
    .set({
      status: "success",
      latencyMs,
      responseJson: { ...execution.value, acpId },
    })
    .where(eq(toolCallLog.id, toolCallId));

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_end",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, status: "success", acpId },
  });

  const toolResult = execution.ok && execution.value ? execution.value : {};

  return {
    toolCalls: [...state.toolCalls, { toolCallId, toolName, status: "success", acpId }],
    observations: toolResult["analystTeamResult"]
      ? [...state.observations, { analystTeamResult: toolResult["analystTeamResult"] }]
      : state.observations,
  };
}

/** Try to extract a ticker symbol from free-form text */
function extractTickerFromText(text: string): string | null {
  // Match $SYMBOL, SYMBOL.SH, SYMBOL.SZ patterns
  const match = text.match(/\$([A-Z]{1,6})|([A-Z0-9]{6})\.(SH|SZ)|([A-Z]{1,5})\b/);
  if (match) return match[1] ?? match[2] ?? match[4] ?? null;
  return null;
}

