import { eq } from "drizzle-orm";
import { registerBuiltinConnectors } from "../../../connectors/bootstrap";
import { connectorRegistry } from "../../../connectors/registry";
import { getDb, getSqliteForTesting } from "../../../db/sqlite/client";
import { workflowRun } from "../../../db/sqlite/schema";
import {
  buildArtifactGapHint,
  checkRequiredArtifacts,
  resolveScenarioKey,
} from "../../agent-readiness/quality/artifact-checker";
import { buildAcpRequest, defaultAcpCaller } from "../../../messaging/acp";
import { dispatchMcpToolCall } from "../../mcp/dispatcher";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import { logResearchTeamInteraction } from "../../research-team/interaction-log";
import { sandboxExecutor } from "../../sandbox-executor";
import { dispatchBuiltinTool, isBuiltinTool } from "../../tools/builtin-tools";
import { parseToolCallFromReason, stripToolCallSentinels } from "../../tools/tool-call-format";
import {
  recordToolCallError,
  recordToolCallSandboxBlocked,
  recordToolCallStart,
  recordToolCallSuccess,
  recordToolCallTimeout,
} from "../../tools/tool-call-log-service";
import { resolveToolAlias } from "../../tools/tool-catalog";
import { resolveConnectorForServerAlias, resolveConnectorForTool } from "../../tools/tool-routes";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { isLikelyProjectIdFormat } from "./project-id";
import { buildMcpRetryHint, classifyToolError } from "./tool-error-classifier";

/**
 * P2 优先级（Round 7 复盘 2026-06-08）：artifact gate 最多 push back 几次。
 *
 * 触发：LLM 输出 `{"tool":"none"}` 想停机 + scenario 的 requiredArtifacts 还没满足。
 * 上限 2：第 1/2 次把 hint 塞回 observation 让 graph 回 reason 再跑；第 3 次放行，
 * 写 finalResponse，让评测真实记录 A-1=0，而不是死循环卡死。
 *
 * 同时受 def.maxIterations 上限保护（execute-agent-react.ts:438）—— 即便 gate 想 push back
 * 但已到 max iteration，graph 会自然 finalize。
 */
const MAX_ARTIFACT_GATE_RETRIES = 2;

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
    const cleanedReason = stripToolCallSentinels(state.reasonText ?? "");
    const summary = parsed.summary?.trim() || cleanedReason.slice(0, 2000) || "no tool requested";

    /**
     * P2 artifact gate：在写 finalResponse 之前反查 scenario 的 requiredArtifacts。
     * 三种结局：
     *   - 反查不到 scenario（workflow 未 tag / 旧 DB） → fallback 老行为，直接 finalize
     *   - 反查到 + 已满足 → 直接 finalize
     *   - 反查到 + 未满足 + retry < MAX → push back observation，让 graph 回 reason
     *   - 反查到 + 未满足 + retry ≥ MAX → 放行 finalize（让 A-1=0 真实暴露给评测）
     */
    const sqliteHandle = (() => {
      try {
        return getSqliteForTesting();
      } catch {
        return null;
      }
    })();
    const scenarioKey = sqliteHandle ? resolveScenarioKey(sqliteHandle, state.workflowId) : null;
    if (sqliteHandle && scenarioKey) {
      const gate = checkRequiredArtifacts(sqliteHandle, scenarioKey, state.workflowId);
      const retryCount = state.artifactGapRetryCount ?? 0;
      if (!gate.ok && retryCount < MAX_ARTIFACT_GATE_RETRIES) {
        const hint = buildArtifactGapHint(gate);
        emit({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          role: state.agentDefinition.role,
          type: "observe",
          stepIndex: state.iteration,
          ts: Date.now(),
          payload: {
            level: "warn",
            artifactGapHint: true,
            scenario: scenarioKey,
            missing: gate.missing,
            retryCount: retryCount + 1,
            maxRetries: MAX_ARTIFACT_GATE_RETRIES,
            message: `[artifact gate] 拦截 tool=none：${gate.missing
              .map((m) => `${m.table}=${m.rows}/${m.minRows}`)
              .join(", ")}`,
          },
        });
        return {
          observations: [
            ...state.observations,
            {
              level: "warn",
              artifactGapHint: true,
              scenario: scenarioKey,
              missing: gate.missing,
              retryCount: retryCount + 1,
              maxRetries: MAX_ARTIFACT_GATE_RETRIES,
              hint,
              reasonText: state.reasonText,
            },
          ],
          artifactGapRetryCount: retryCount + 1,
          /** 关键：不写 finalResponse，shouldStopReactLoopAfterObserve 不命中 → 回 reason */
        };
      }
    }

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
        summary,
      },
    });
    /**
     * 关键修复（防 ReAct 死循环）：
     * LLM 明确表达"无需调用工具"时，应将 reason 阶段的文字结论作为本轮终态
     * 直接 finalize。先前实现只产生 observation，但 reason 节点会强制把
     * `plannedAction` 写成 `"tool_call"`（只要 hasTools），导致
     * `shouldStopReactLoopAfterObserve` 永远不命中 stop，ReAct 反复重跑同一
     * 提示，token 持续累积，前端看到的就是「Orchestrator 一直循环」的现象。
     */
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
      finalResponse: {
        status: "completed",
        role: state.agentDefinition.role,
        iteration: state.iteration,
        skippedToolCall: true,
        summary,
      },
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
        {
          level: "error",
          toolParseError: true,
          message: parsed.message,
          reasonText: state.reasonText,
        },
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

  /**
   * Step 3：deprecated 别名工具透明跳转到 `replacedBy` 指向的工具。
   * 旧 prompt / 旧 agent 定义仍可调用 fetch_bars / fetch_macro_data 等老名字，
   * 但实际执行的是 fetch_klines / compute_macro_indicators，让链路自动收敛。
   * 只对 mcp=undefined 的情况生效（mcp 工具名不在 catalog 中，不需要 alias 跳转）。
   */
  if (!mcp) {
    const aliasResolution = resolveToolAlias(effectiveToolName);
    if (aliasResolution.aliased) {
      emit({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        role: state.agentDefinition.role,
        type: "observe",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: {
          level: "warn",
          toolAlias: true,
          originalTool: aliasResolution.originalName,
          resolvedTool: aliasResolution.resolved,
          message: `tool '${aliasResolution.originalName}' is deprecated; routed to '${aliasResolution.resolved}'`,
        },
      });
      effectiveToolName = aliasResolution.resolved;
    }
  }

  const connectorTarget = !mcp
    ? (resolveConnectorForTool(effectiveToolName) ??
      (parsedMcp ? resolveConnectorForServerAlias(parsedMcp.serverName) : undefined))
    : undefined;
  const targetKind: "mcp" | "tool" | "connector" = mcp
    ? "mcp"
    : connectorTarget
      ? "connector"
      : "tool";
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

  /**
   * F-P0-12（2026-06-05 eval batch 3 round 3 / case 1 修复）：
   *
   * 多个 connector / builtin tool 都要求 `projectId`（如 qubit-research/version_strategy、
   * factor.register、rule.register 等）。LLM 经常忘传或写成占位符 \`"<ctx.projectId>"\` /
   * `"default"`。为了让 strategy_authoring / discovery 等"必须落 DB 的工具"不要因为
   * projectId 缺失而硬失败，act 节点统一从 workflow_run → project_id 取真值兜底注入：
   *
   *   - LLM 传了非空字符串 → 尊重 LLM 的值（除非是明显占位符 "<ctx.projectId>" / "TODO"）
   *   - LLM 没传 / 传空 / 传占位符 → 用 workflow_run.project_id 兜底
   *
   * 与 workflowRunId 同样语义（line 107），让 ReAct-loop 写出来的工具调用更稳定。
   */
  /**
   * F-P0-12 扩展（2026-06-05 监控复盘 #3 + B+ Phase 1.1）：
   *
   * 第 1 版用反向黑名单 (`default` / `project_id` / `todo` 等)，但 LLM 会创造
   * 新的业务化占位（`ai_semiconductor_technical`、`aapl_trend_v1`、`nvda_research`），
   * 黑名单覆盖不到，再被传到 factor.autoEvaluate 内部 register 时仍触发
   * `FOREIGN KEY constraint failed`（实测 workflow 4614e8b1 因此 fail）。
   *
   * 改成**正向白名单** `isLikelyProjectIdFormat`：只有 UUID 形态或 `proj-*` 老 seed
   * 才被认为是合法 projectId，其他一律兜底为 `workflow_run.project_id`。
   */
  const incomingProjectId =
    (toolParams["projectId"] as string | undefined) ??
    (toolParams["project_id"] as string | undefined);
  if (!isLikelyProjectIdFormat(incomingProjectId) && projectId) {
    enrichedToolParams["projectId"] = projectId;
    enrichedToolParams["project_id"] = projectId;
  }

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

  await recordToolCallStart({
    toolCallId,
    agentStepId,
    workflowRunId: state.workflowId,
    traceId: state.traceId,
    /** 监控 v3 P0：让 tool_call_log / mcp_call_log 直接落 agent_definition_id 冗余 */
    agentDefinitionId: state.agentDefinition.id,
    targetName,
    toolKind,
    targetKind,
    ...(mcp ? { mcp } : {}),
    reasonText: state.reasonText ?? "",
    contextMemory: state.contextMemory,
  });

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
    await recordToolCallSandboxBlocked({
      toolCallId,
      hasMcp: Boolean(mcp),
      reason: check.reason ?? "blocked by sandbox",
      ...(check.violationType ? { violationType: check.violationType } : {}),
    });

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
        status: "blocked_by_sandbox",
        reason: check.reason,
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
      payload: {
        level: "error",
        sandbox: true,
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
    /**
     * P1-D：3 个分支（mcp/connector/builtin）的错误处理统一为
     * `{result:"error", toolError:true, errorSource, errorMessage}`，让 ReAct 后续
     * 走 classifier + hint 回写 observation，不再让 connector/builtin 错误
     * 打爆整个 graph（在 P0-C 之前会被 executeAgentReact catch 标 status=failed）。
     */
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
          return {
            result: "error" as const,
            toolError: true,
            errorSource: "mcp" as const,
            errorMessage,
          };
        }
      }
      if (connectorTarget) {
        try {
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
            /**
             * 2026-06-05 监控复盘 #3 修复：之前只把 `response.errorCode` 当 errorMessage
             * 给 LLM（如 "ACP_CONNECTOR_ERROR"），detail 全丢，LLM 无法自修。
             * 现在拼上 errorDetail（lastError.message slice 800）：
             *   "ACP_CONNECTOR_ERROR: factor 4f... not found in this project"
             * 这样 LLM 在下一轮 react 能看到具体原因，自修参数 / 切换工具。
             */
            const code = response.errorCode ?? response.status ?? "connector_call_failed";
            const detail = response.errorDetail?.trim();
            const errorMessage = detail ? `${code}: ${detail}` : code;
            return {
              result: "error" as const,
              toolError: true,
              errorSource: "connector" as const,
              errorMessage,
            };
          }
          return { result: "ok" as const, connectorResult: response.result };
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            result: "error" as const,
            toolError: true,
            errorSource: "connector" as const,
            errorMessage,
          };
        }
      }
      if (isBuiltinTool(effectiveToolName)) {
        try {
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
            /**
             * 透传 toolCallId / agentStepId 给 builtin handler，让 shell.exec /
             * cli_agent.run 能在 exec_call_log（与 tool_call_log 1:1 同主键）落库。
             */
            toolCallId,
            agentStepId,
          };
          const builtinResult = await dispatchBuiltinTool(
            effectiveToolName,
            toolCtx,
            enrichedParams
          );
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
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          return {
            result: "error" as const,
            toolError: true,
            errorSource: "builtin" as const,
            errorMessage,
          };
        }
      }
      return {
        result: "error" as const,
        toolError: true,
        errorSource: "unknown" as const,
        errorMessage: `Tool "${effectiveToolName}" is not implemented. Add it to builtin-tools or tool-routes (connector).`,
      };
    },
    meta: { toolName: effectiveToolName },
  });

  if (!execution.ok) {
    const latencyMs = Date.now() - startedAt;
    await recordToolCallTimeout({
      toolCallId,
      hasMcp: Boolean(mcp),
      latencyMs,
      reason: execution.result.reason ?? "tool timeout",
      ...(execution.result.violationType ? { violationType: execution.result.violationType } : {}),
    });
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
        status: "timeout",
        reason: execution.result.reason,
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
    toolError?: boolean;
    errorSource?: "mcp" | "connector" | "builtin" | "unknown";
    errorMessage?: string;
  };
  /**
   * P1-D：把 P0-4 的"MCP 错误转 observation"扩展到 connector / builtin / unknown
   * 所有 toolError 分支。LLM 看到结构化 hint 后能换工具/换参，而不是让整个 graph
   * 因为一次 connector_call_failed 就被打爆 status=failed（P0-C 之后 throw 会被
   * executeAgentReact catch 标 failed，对用户体验最差）。
   *
   * 行为差异：
   *   - mcp：同时更新 mcp_call_log 与 tool_call_log
   *   - connector / builtin：只更 tool_call_log
   *   - errorClass / hint 文案对所有 source 通用（classifier 只看 errorMessage）
   */
  if (execValue.result === "error" && execValue.toolError) {
    const latencyMs = Date.now() - startedAt;
    const errMsg = execValue.errorMessage ?? "tool call failed";
    const errorSource = execValue.errorSource ?? "unknown";
    await recordToolCallError({
      toolCallId,
      hasMcp: Boolean(mcp),
      latencyMs,
      errorSource,
      errorMessage: errMsg,
    });
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
        toolError: true,
        errorSource,
        targetKind,
        targetName,
      },
    });
    const errorClass = classifyToolError(errMsg);
    const retryable = errorClass === "transient";
    const hint = buildMcpRetryHint(errorClass, errMsg, targetName);
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
        toolError: true,
        errorSource,
        message: errMsg,
        errorClass,
        retryable,
        hint,
      },
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        {
          toolCallId,
          toolName: targetName,
          status: "failed",
          reason: errMsg,
          toolError: true,
          errorSource,
        },
      ],
      observations: [
        ...state.observations,
        {
          level: "error",
          toolError: true,
          errorSource,
          message: errMsg,
          errorClass,
          retryable,
          hint,
          reasonText: state.reasonText,
        },
      ],
    };
  }

  const latencyMs = Date.now() - startedAt;
  await recordToolCallSuccess({
    toolCallId,
    hasMcp: Boolean(mcp),
    latencyMs,
    responsePayload: execution.value as Record<string, unknown>,
  });

  emit({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    role: state.agentDefinition.role,
    type: "tool_call_end",
    stepIndex: state.iteration,
    ts: Date.now(),
    payload: { toolCallId, status: "success", targetKind, targetName },
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
    toolCalls: [...state.toolCalls, { toolCallId, toolName: targetName, status: "success" }],
    observations: nextObservations,
  };
}
