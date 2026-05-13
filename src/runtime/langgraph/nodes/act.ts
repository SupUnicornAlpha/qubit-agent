import { getDb } from "../../../db/sqlite/client";
import { acpCall, mcpCallLog, toolCallLog, workflowRun } from "../../../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { buildAcpRequest, defaultAcpCaller } from "../../../messaging/acp";
import { sandboxExecutor } from "../../sandbox-executor";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { runAnalystTeam } from "../../msa/analyst-team";
import { dispatchMcpToolCall } from "../../mcp/dispatcher";
import { logResearchTeamInteraction } from "../../research-team/interaction-log";

/** Builtin tools routed to ACP connectors (see registerBuiltinConnectors). */
const TOOL_CONNECTOR_ROUTES: Record<string, string> = {
  fetch_bars: "qubit-data",
  fetch_klines: "qubit-data",
  fetch_ticks: "qubit-data",
  write_snapshot: "qubit-data",
  fetch_news: "qubit-news",
  extract_event: "qubit-news",
  score_sentiment: "qubit-news",
};

type ExtractedToolCall = {
  toolName: string;
  params: Record<string, unknown>;
  mcp?: {
    serverName: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
};

/** Extract tool name and params from LLM reason text */
function extractToolCall(reasonText: string, availableTools: string[]): ExtractedToolCall {
  // Try to parse JSON tool call from reason text
  try {
    const match = reasonText.match(/\{[\s\S]*"tool"[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as Record<string, unknown>;
      const toolName = typeof parsed["tool"] === "string" ? parsed["tool"] : "";
      if (toolName && availableTools.includes(toolName)) {
        const params = (parsed["params"] ?? parsed["parameters"] ?? {}) as Record<string, unknown>;
        const mcp =
          toolName === "call_mcp" || toolName.startsWith("mcp:")
            ? extractMcpMeta(toolName, params)
            : undefined;
        return { toolName, params, mcp };
      }
    }
  } catch {
    // fall through
  }
  // Try to find tool name mentioned in text
  for (const tool of availableTools) {
    if (reasonText.includes(tool)) {
      const mcp = tool === "call_mcp" || tool.startsWith("mcp:") ? extractMcpMeta(tool, {}) : undefined;
      return { toolName: tool, params: {}, mcp };
    }
  }
  return { toolName: availableTools[0] ?? "noop_tool", params: {} };
}

function extractMcpMeta(
  toolName: string,
  params: Record<string, unknown>
): ExtractedToolCall["mcp"] | undefined {
  if (toolName.startsWith("mcp:")) {
    // format: mcp:<server>:<tool>
    const parts = toolName.split(":");
    if (parts.length >= 3) {
      return {
        serverName: parts[1] ?? "unknown",
        toolName: parts.slice(2).join(":"),
        arguments: params,
      };
    }
  }
  const serverName =
    (typeof params["serverName"] === "string" ? params["serverName"] : undefined) ??
    (typeof params["server"] === "string" ? params["server"] : undefined);
  const mcpToolName =
    (typeof params["mcpTool"] === "string" ? params["mcpTool"] : undefined) ??
    (typeof params["toolName"] === "string" ? params["toolName"] : undefined) ??
    (typeof params["tool"] === "string" ? params["tool"] : undefined);
  const argumentsValue = params["arguments"];
  const argumentsObj =
    argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)
      ? (argumentsValue as Record<string, unknown>)
      : {};
  if (serverName && mcpToolName) {
    return {
      serverName,
      toolName: mcpToolName,
      arguments: argumentsObj,
    };
  }
  return undefined;
}

export async function actNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string,
  agentStepId: string
): Promise<Partial<AgentGraphState>> {
  const { toolName, params: toolParams, mcp } = extractToolCall(
    state.reasonText ?? "",
    state.agentDefinition.tools
  );
  const connectorTarget = !mcp ? TOOL_CONNECTOR_ROUTES[toolName] : undefined;
  const targetKind: "mcp" | "tool" | "connector" = mcp ? "mcp" : connectorTarget ? "connector" : "tool";
  const targetName = mcp
    ? `${mcp.serverName}/${mcp.toolName}`
    : connectorTarget
      ? `${connectorTarget}/${toolName}`
      : toolName;
  const toolKind: "mcp" | "builtin" | "acp_connector" = mcp
    ? "mcp"
    : connectorTarget
      ? "acp_connector"
      : "builtin";
  const toolCallId = crypto.randomUUID();
  const db = await getDb();
  const workflowRows = await db
    .select({ projectId: workflowRun.projectId })
    .from(workflowRun)
    .where(eq(workflowRun.id, state.workflowId))
    .limit(1);
  const projectId = workflowRows[0]?.projectId;

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_start",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, toolName, targetKind, targetName },
  });

  await db.insert(toolCallLog).values({
    id: toolCallId,
    agentStepId,
    toolName: targetName,
    toolKind,
    requestJson: {
      reasonText: state.reasonText,
      contextMemory: state.contextMemory,
      targetKind,
      mcp: mcp ?? null,
    },
    status: "success",
    latencyMs: 1,
  });
  void logResearchTeamInteraction({
    workflowRunId: state.workflowId,
    fromRole: state.agentDefinition.role,
    toRole: "__tools__",
    kind: "tool_call",
    toolKind,
    toolName: targetName,
    contentText: `${String(targetKind)} → ${targetName}`,
    payloadJson: { toolCallId, toolName, targetKind },
  });
  if (mcp) {
    await db.insert(mcpCallLog).values({
      id: toolCallId,
      workflowRunId: state.workflowId,
      agentStepId,
      serverName: mcp.serverName,
      toolName: mcp.toolName,
      requestJson: {
        reasonText: state.reasonText,
        arguments: mcp.arguments,
      },
      status: "success",
      latencyMs: 1,
    });
  }

  const check = mcp
    ? await sandboxExecutor.checkMcpCall({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        agentInstanceId,
        definition: state.agentDefinition,
        serverName: mcp.serverName,
        payload: {
          plannedAction: state.plannedAction ?? "unknown",
          toolName: mcp.toolName,
          arguments: mcp.arguments,
        },
      })
    : connectorTarget
      ? await sandboxExecutor.checkConnectorCall({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          agentInstanceId,
          definition: state.agentDefinition,
          connectorName: connectorTarget,
          payload: toolParams,
        })
      : await sandboxExecutor.checkToolCall({
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
      targetKind,
      targetName,
      intent: state.plannedAction ?? "tool_call",
      status: "blocked_by_sandbox",
        errorCode: check.violationType ?? (mcp ? "mcp_not_allowed" : connectorTarget ? "connector_not_allowed" : "tool_not_allowed"),
    });

    await db
      .update(toolCallLog)
      .set({
        status: "sandbox_blocked",
        errorMessage: check.reason ?? "blocked by sandbox",
      })
      .where(eq(toolCallLog.id, toolCallId));
    if (mcp) {
      await db
        .update(mcpCallLog)
        .set({
          status: "sandbox_blocked",
          errorCode: check.violationType ?? "mcp_not_allowed",
          responseJson: { reason: check.reason ?? "blocked by sandbox" },
        })
        .where(eq(mcpCallLog.id, toolCallId));
    }

    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_call_end",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolCallId, status: "blocked_by_sandbox", reason: check.reason, targetKind, targetName },
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
        { toolCallId, toolName: targetName, status: "blocked_by_sandbox", reason: check.reason },
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
      if (mcp) {
        const mcpResult = await dispatchMcpToolCall({
          projectId: projectId ?? undefined,
          serverName: mcp.serverName,
          toolName: mcp.toolName,
          arguments: mcp.arguments,
        });
        return { result: "ok" as const, mcpResult };
      }
      if (connectorTarget) {
        const policy = await sandboxExecutor.loadPolicy(state.agentDefinition);
        const request = buildAcpRequest({
          sessionId: state.inboundMessage.messageId,
          workflowId: state.workflowId,
          senderAgent: agentInstanceId,
          targetKind: "connector",
          targetName: connectorTarget,
          intent: toolName,
          payload: { operation: toolName, params: toolParams },
          timeoutMs: policy.maxToolCallMs,
        });
        const response = await defaultAcpCaller.call(request);
        if (response.status !== "success") {
          throw new Error(response.errorCode ?? response.status ?? "connector_call_failed");
        }
        return { result: "ok" as const, connectorResult: response.result };
      }
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
      targetKind,
      targetName,
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
    if (mcp) {
      await db
        .update(mcpCallLog)
        .set({
          status: "timeout",
          latencyMs,
          errorCode: execution.result.violationType ?? "timeout",
          responseJson: { reason: execution.result.reason ?? "tool timeout" },
        })
        .where(eq(mcpCallLog.id, toolCallId));
    }
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_call_end",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolCallId, status: "timeout", reason: execution.result.reason, targetKind, targetName },
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
        { toolCallId, toolName: targetName, status: "timeout", reason: execution.result.reason },
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
    targetKind,
    targetName,
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
  if (mcp) {
    await db
      .update(mcpCallLog)
      .set({
        status: "success",
        latencyMs,
        responseJson: { ...execution.value, acpId },
      })
      .where(eq(mcpCallLog.id, toolCallId));
  }

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_end",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, status: "success", acpId, targetKind, targetName },
  });

  const toolResult = execution.ok && execution.value ? execution.value : {};
  const nextObservations = [...state.observations];
  if (toolResult["analystTeamResult"]) {
    nextObservations.push({ analystTeamResult: toolResult["analystTeamResult"] });
  }
  if (toolResult["mcpResult"]) {
    nextObservations.push({ mcpResult: toolResult["mcpResult"] });
  }
  if (toolResult["connectorResult"] !== undefined) {
    nextObservations.push({ connectorResult: toolResult["connectorResult"] });
  }

  return {
    toolCalls: [...state.toolCalls, { toolCallId, toolName: targetName, status: "success", acpId }],
    observations: nextObservations,
  };
}

/** Try to extract a ticker symbol from free-form text */
function extractTickerFromText(text: string): string | null {
  // Match $SYMBOL, SYMBOL.SH, SYMBOL.SZ patterns
  const match = text.match(/\$([A-Z]{1,6})|([A-Z0-9]{6})\.(SH|SZ)|([A-Z]{1,5})\b/);
  if (match) return match[1] ?? match[2] ?? match[4] ?? null;
  return null;
}

