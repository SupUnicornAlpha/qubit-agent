import { getDb } from "../../../db/sqlite/client";
import { acpCall, mcpCallLog, toolCallLog, workflowRun } from "../../../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { buildAcpRequest, defaultAcpCaller } from "../../../messaging/acp";
import { sandboxExecutor } from "../../sandbox-executor";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { dispatchMcpToolCall } from "../../mcp/dispatcher";
import { logResearchTeamInteraction } from "../../research-team/interaction-log";
import { dispatchBuiltinTool, isBuiltinTool } from "../../tools/builtin-tools";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import { parseToolCallFromReason } from "../../tools/tool-call-format";
import { resolveConnectorForTool, resolveConnectorForServerAlias } from "../../tools/tool-routes";
import { registerBuiltinConnectors } from "../../../connectors/bootstrap";
import { connectorRegistry } from "../../../connectors/registry";

export async function actNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string,
  agentStepId: string
): Promise<Partial<AgentGraphState>> {
  const effective = await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId);
  const availableTools = effective.tools;
  const parsed = parseToolCallFromReason(state.reasonText ?? "", availableTools);

  if (parsed.kind === "none") {
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: {
        level: "info",
        skippedToolCall: true,
        summary: parsed.summary ?? "no tool requested",
      },
    });
    return {
      observations: [
        ...state.observations,
        {
          level: "info",
          skippedToolCall: true,
          reasonText: state.reasonText,
          summary: parsed.summary,
        },
      ],
    };
  }

  if (parsed.kind === "parse_error") {
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { level: "error", toolParseError: true, message: parsed.message },
    });
    return {
      observations: [
        ...state.observations,
        { level: "error", toolParseError: true, message: parsed.message, reasonText: state.reasonText },
      ],
    };
  }

  const { toolName, params: toolParams, mcp: parsedMcp } = parsed;
  const enrichedToolParams: Record<string, unknown> = {
    ...toolParams,
    workflowRunId: (toolParams["workflowRunId"] as string | undefined) ?? state.workflowId,
  };

  /** LLM 误用 call_mcp(serverName=qubit-news) 时转 connector 执行 */
  let mcp = parsedMcp;
  let effectiveToolName = toolName;
  if (parsedMcp) {
    await registerBuiltinConnectors();
    const connectorAlias = resolveConnectorForServerAlias(parsedMcp.serverName);
    if (connectorAlias && connectorRegistry.get(connectorAlias)) {
      mcp = undefined;
      effectiveToolName = parsedMcp.toolName;
      enrichedToolParams["operation"] = parsedMcp.toolName;
      Object.assign(enrichedToolParams, parsedMcp.arguments ?? {});
    }
  }

  const connectorTarget = !mcp
    ? resolveConnectorForTool(effectiveToolName) ?? (parsedMcp ? resolveConnectorForServerAlias(parsedMcp.serverName) : undefined)
    : undefined;
  const targetKind: "mcp" | "tool" | "connector" = mcp ? "mcp" : connectorTarget ? "connector" : "tool";
  const targetName = mcp
    ? `${mcp.serverName}/${mcp.toolName}`
    : connectorTarget
      ? `${connectorTarget}/${effectiveToolName}`
      : effectiveToolName;
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
          payload: enrichedToolParams,
        })
      : await sandboxExecutor.checkToolCall({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          agentInstanceId,
          toolName: effectiveToolName,
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
        try {
          const mcpResult = await dispatchMcpToolCall({
            projectId: projectId ?? undefined,
            definitionId: state.agentDefinition.id,
            serverName: mcp.serverName,
            toolName: mcp.toolName,
            arguments: mcp.arguments,
          });
          return { result: "ok" as const, mcpResult };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return { result: "error" as const, mcpError: true, errorMessage };
        }
      }
      if (connectorTarget) {
        const policy = await sandboxExecutor.loadPolicy(state.agentDefinition);
        const request = buildAcpRequest({
          sessionId: state.inboundMessage.messageId,
          workflowId: state.workflowId,
          senderAgent: agentInstanceId,
          targetKind: "connector",
          targetName: connectorTarget,
          intent: effectiveToolName,
          payload: { operation: effectiveToolName, params: enrichedToolParams },
          timeoutMs: policy.maxToolCallMs,
        });
        const response = await defaultAcpCaller.call(request);
        if (response.status !== "success") {
          throw new Error(response.errorCode ?? response.status ?? "connector_call_failed");
        }
        return { result: "ok" as const, connectorResult: response.result };
      }
      if (isBuiltinTool(effectiveToolName)) {
        const enrichedParams = {
          ...enrichedToolParams,
          ticker:
            (enrichedToolParams["ticker"] as string | undefined) ??
            (enrichedToolParams["symbol"] as string | undefined),
        };
        const toolCtx = {
          workflowId: state.workflowId,
          runId: state.runId,
          traceId: state.traceId,
          agentInstanceId,
          projectId,
          definition: state.agentDefinition,
          reasonText: state.reasonText,
          inboundPayload: state.inboundMessage.payload as Record<string, unknown>,
        };
        const builtinResult = await dispatchBuiltinTool(effectiveToolName, toolCtx, enrichedParams);
        if (effectiveToolName === "run_analyst_team") {
          return { result: "ok" as const, analystTeamResult: builtinResult };
        }
        if (effectiveToolName === "edit_agent_pack") {
          return { result: "ok" as const, packEdit: builtinResult };
        }
        if (effectiveToolName === "fuse_signals") {
          return { result: "ok" as const, fusionResult: builtinResult };
        }
        return { result: "ok" as const, builtinResult };
      }
      throw new Error(
        `Tool "${effectiveToolName}" is not implemented. Add it to builtin-tools or tool-routes (connector).`
      );
    },
    meta: { toolName: effectiveToolName },
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

  const execValue = execution.value as {
    result?: string;
    mcpError?: boolean;
    errorMessage?: string;
  };
  if (execValue.result === "error" && execValue.mcpError) {
    const latencyMs = Date.now() - startedAt;
    const errMsg = execValue.errorMessage ?? "mcp call failed";
    const failAcpId = crypto.randomUUID();
    await db.insert(acpCall).values({
      id: failAcpId,
      workflowRunId: state.workflowId,
      traceId: state.traceId,
      agentStepId,
      callerInstanceId: agentInstanceId,
      targetKind,
      targetName,
      intent: state.plannedAction ?? "tool_call",
      status: "error",
      latencyMs,
      errorCode: "mcp_call_failed",
    });
    await db
      .update(toolCallLog)
      .set({
        status: "error",
        latencyMs,
        errorMessage: errMsg,
        responseJson: { mcpError: true, errorMessage: errMsg },
      })
      .where(eq(toolCallLog.id, toolCallId));
    if (mcp) {
      await db
        .update(mcpCallLog)
        .set({
          status: "failed",
          latencyMs,
          errorCode: "mcp_call_failed",
          responseJson: { errorMessage: errMsg },
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
      payload: {
        toolCallId,
        status: "failed",
        reason: errMsg,
        mcpError: true,
        targetKind,
        targetName,
      },
    });
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { level: "error", mcpError: true, message: errMsg },
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        { toolCallId, toolName: targetName, status: "failed", reason: errMsg, mcpError: true },
      ],
      observations: [
        ...state.observations,
        { level: "error", mcpError: true, message: errMsg, reasonText: state.reasonText },
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

  const resultPreview = (() => {
    try {
      return JSON.stringify(execution.value).slice(0, 1200);
    } catch {
      return String(execution.value).slice(0, 1200);
    }
  })();
  void logResearchTeamInteraction({
    workflowRunId: state.workflowId,
    fromRole: state.agentDefinition.role,
    toRole: "__tools__",
    kind: "tool_call",
    toolKind,
    toolName: targetName,
    contentText: `✓ ${targetName} (${latencyMs}ms)\n${resultPreview}`,
    payloadJson: { toolCallId, toolName, targetKind, status: "success", result: execution.value },
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
  if (toolResult["packEdit"]) {
    nextObservations.push({ packEdit: toolResult["packEdit"] });
  }
  if (toolResult["builtinResult"]) {
    nextObservations.push({ builtinResult: toolResult["builtinResult"] });
  }
  if (toolResult["fusionResult"]) {
    nextObservations.push({ fusionResult: toolResult["fusionResult"] });
  }

  return {
    toolCalls: [...state.toolCalls, { toolCallId, toolName: targetName, status: "success", acpId }],
    observations: nextObservations,
  };
}

