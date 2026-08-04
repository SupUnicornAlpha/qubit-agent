import { planContractRecovery } from "../../policy";
import { buildArtifactGapHint } from "../../agent-readiness/quality/artifact-checker";
import { getScenarioExpectation } from "../../agent-readiness/quality/scenario-expectations";
import {
  isRedundantTopologyProbe,
  shouldForceTopologySpecialistSynthesis,
} from "../../orchestration/topology-dispatch";
import { logResearchTeamInteraction } from "../../research-team/interaction-log";
import { sandboxExecutor } from "../../sandbox-executor";
import { autoMarkRecalledSkillsAsExecuted } from "../../skills/auto-skill-execution-hook";
import { classifyDataGap, toolMatchesRequiredCapability } from "../../tools/data-gap";
import {
  assessRequiredToolGate,
  buildRequiredToolNextActionHint,
} from "../../tools/required-tool-gate";
import { SCENARIO_STALL_TOOLS } from "../../research-scenario/scenario-key-aliases";
import { parseToolCallFromReason } from "../../tools/tool-call-format";
import {
  buildToolCallFingerprint,
  findReusableSuccessfulToolCall,
  shouldTerminateForNoProgress,
} from "../../tools/tool-call-dedup";
import {
  findWorkflowArtifactByFingerprint,
  recordWorkflowDataGap,
  recordWorkflowToolArtifact,
} from "../../tools/workflow-artifact-ledger";
import { applyToolResultToWorkingMemory } from "../../context/working-memory";
import { compactToolObservationValue } from "../../tools/compact-tool-observation";
import {
  recordToolCallError,
  recordToolCallSandboxBlocked,
  recordToolCallStart,
  recordToolCallSuccess,
  recordToolCallTimeout,
} from "../../tools/tool-call-log-service";
import { detectSemanticToolFailure } from "../../tools/semantic-tool-result";
import { recordWorkflowToolFailure } from "../../tools/tool-governance-policy";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { buildMcpRetryHint, classifyToolError } from "./tool-error-classifier";
import { buildToolRecoveryPlan } from "./tool-recovery-policy";
import { handleToolNoneAction } from "./terminal-turn-policy";
import { admitTool } from "./tool-admission";
import { executeAdmittedTool } from "./tool-executor";
import { buildToolPlan } from "./tool-plan";

/** Nodes consume the runner-owned facts; they must not reload snapshots mid-turn. */
function resolveSharedSnapshot(state: AgentGraphState) {
  const context = state.iterationContext;
  if (context?.workflowId === state.workflowId) return context.snapshot;
  return state.scenarioSnapshot?.workflowId === state.workflowId ? state.scenarioSnapshot : null;
}

export async function actNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string,
  agentStepId: string
): Promise<Partial<AgentGraphState>> {
  const iterationContext = state.iterationContext;
  if (!iterationContext || iterationContext.workflowId !== state.workflowId) {
    throw new Error("actNode requires runner-owned IterationContext");
  }
  const projectId = iterationContext.projectId ?? undefined;
  const agentMode = iterationContext.agentMode;
  const processConfig = iterationContext.processConfig;
  const planSnapshot = iterationContext.planJson;
  const availableTools = iterationContext.availableTools;
  let parsed = parseToolCallFromReason(state.reasonText ?? "", availableTools);

  /**
   * A market-data child used to repeatedly resolve the same symbol and exhaust
   * its no-progress budget without ever fetching a bar.  Once a symbol has
   * been resolved in this task, the next repeated resolve is deterministically
   * advanced to the historical-data tool with the same symbol.  This preserves
   * the model-selected instrument while preventing an inventory loop.
   */
  const resolvedSymbol =
    parsed.kind === "tool"
      ? typeof parsed.params.symbol === "string"
        ? parsed.params.symbol.trim()
        : typeof parsed.params.ticker === "string"
          ? parsed.params.ticker.trim()
          : ""
      : "";

  if (
    parsed.kind === "tool" &&
    state.agentDefinition.role === "market_data" &&
    (parsed.toolName === "market.resolve_symbol" || parsed.toolName === "resolve_symbol") &&
    resolvedSymbol.length > 0 &&
    availableTools.includes("fetch_klines") &&
    state.toolCalls.some(
      (call) =>
        String(call.toolName ?? "") === "market.resolve_symbol" &&
        (call.status === "success" || call.status === "deduplicated")
    )
  ) {
    parsed = {
      kind: "tool",
      toolName: "fetch_klines",
      params: {
        ...parsed.params,
        symbol: resolvedSymbol,
      },
    };
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
        code: "MARKET_RESOLUTION_AUTO_ADVANCE",
        message: "标的已识别，系统将重复的市场识别推进为 fetch_klines。",
        suggestedTool: "fetch_klines",
      },
    });
  }

  // The reason node deliberately gets a final tool-free synthesis turn once a
  // topology specialist has enough evidence. Guard against a stale provider
  // tool call so it cannot burn the remaining turn budget.
  const inboundPayloadForSynthesis = state.inboundMessage.payload as Record<string, unknown>;
  if (
    shouldForceTopologySpecialistSynthesis({
      taskType: String(inboundPayloadForSynthesis.taskType ?? ""),
      role: state.agentDefinition.role,
      toolCalls: state.toolCalls,
    }) &&
    parsed.kind !== "none"
  ) {
    return handleToolNoneAction({
      state,
      emit,
      agentMode,
      processConfig,
      planSnapshot,
      availableTools,
      summary: "专家已达到取证上限，基于已有证据收口",
    });
  }

  if (parsed.kind === "none") {
    return handleToolNoneAction({
      state,
      emit,
      agentMode,
      processConfig,
      planSnapshot,
      availableTools,
      summary: parsed.summary,
    });
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

  const toolPlan = await buildToolPlan({
    parsed,
    workflowId: state.workflowId,
    projectId,
  });
  const {
    requestedToolName: toolName,
    effectiveToolName,
    mcp,
    executionRoute,
    connectorTarget,
    targetKind,
    targetName,
    toolKind,
  } = toolPlan;
  let enrichedToolParams = toolPlan.params;

  if (executionRoute) {
    if (executionRoute.aliased) {
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
          originalTool: executionRoute.originalName,
          resolvedTool: executionRoute.effectiveName,
          route: executionRoute.route,
          message: `tool '${executionRoute.originalName}' is deprecated; routed to '${executionRoute.effectiveName}' (${executionRoute.route})`,
        },
      });
    }
  }

  /**
   * ToolPlan 已在运行器的权威 workflow/project 上绑定上下文参数，取代
   * 旧的 isLikelyProjectIdFormat 启发式补丁：模型传入什么都不能覆盖它们。
   *
   * workflowRunId / projectId / project_id 是**上下文绑定参数**，由 harness 从
   * 权威上下文（state.workflowId / workflow_run.project_id）**无条件注入并覆盖**
   * LLM 传入的任何值。LLM 不需要、也不应该提供这些参数（prompt 已声明会自动填）。
   *
   * 旧实现（反向黑名单 → 正向白名单 isLikelyProjectIdFormat）本质是在"猜 LLM
   * 填的值合不合法"，LLM 会创造新的业务化占位（`nvda_research` 等）绕过白名单，
   * 再到 factor.autoEvaluate 内部 register 时触发 FK constraint failed。
   * 改为 harness 单一事实源后，LLM 填什么都不影响——这类参数对它透明。
   */
  const toolCallId = crypto.randomUUID();
  const inboundPayload = state.inboundMessage.payload as Record<string, unknown>;
  const taskType = String(inboundPayload.taskType ?? "");

  const admission = await admitTool({
    state,
    emit,
    plan: toolPlan,
    projectId,
    agentMode,
    agentStepId,
    toolCallId,
  });
  if (!admission.ok) return admission.patch;
  enrichedToolParams = admission.params;
  const { gateTimeoutMs, capabilityGateAllowed, toolContractName } = admission;

  /**
   * 同一 ReAct（以及 checkpoint resume）内的同参成功读请求直接复用。
   * 过去 `factor.list({})`、resolve_symbol、fetch_quote 会在模型看到简略
   * observation 后被原样重发；这里在真正执行前拦截，避免再次消耗步数和 token。
   */
  const fingerprintParams = mcp
    ? mcp.arguments && typeof mcp.arguments === "object" && !Array.isArray(mcp.arguments)
      ? (mcp.arguments as Record<string, unknown>)
      : {}
    : enrichedToolParams;
  const requestFingerprint = buildToolCallFingerprint({ targetName, params: fingerprintParams });

  // While scenario write-contract tools remain not_attempted, do not burn the
  // budget re-running inventory/probe tools (even with different params).
  if (SCENARIO_STALL_TOOLS.has(targetName)) {
    const priorSuccessCount = state.toolCalls.filter(
      (call) =>
        String(call.toolName ?? "") === targetName &&
        (call.status === "success" || call.status === "deduplicated")
    ).length;
    // Allow one extra screener pass for param tweaks; other stall tools get one shot.
    const maxAllowed = targetName === "run_screener" ? 2 : 1;
    if (priorSuccessCount >= maxAllowed) {
      let nextActionHint: string | null = null;
      const stallSnapshot = resolveSharedSnapshot(state);
      try {
        if (stallSnapshot?.scenarioKey) {
          const requiredTools = getScenarioExpectation(stallSnapshot.scenarioKey).requiredTools;
          const { notAttempted } = assessRequiredToolGate({
            requiredTools,
            authorizedTools: stallSnapshot.authorizedTools,
            attemptedTools: stallSnapshot.attemptedTools,
            runnableTools: availableTools,
            unavailableManifestTools: [],
            market: "UNKNOWN",
          });
          const stillNeededForContract = notAttempted.some((gap) =>
            toolMatchesRequiredCapability(targetName, gap.capability)
          );
          if (notAttempted.length > 0 && !stillNeededForContract) {
            nextActionHint = buildRequiredToolNextActionHint({ notAttempted });
            const goal = typeof inboundPayload.goal === "string" ? inboundPayload.goal : null;
            const recovery = planContractRecovery({
              snapshot: stallSnapshot,
              availableTools,
              goal,
              notAttempted,
            });
            if (recovery.hint) {
              nextActionHint = `${nextActionHint}\n\n${recovery.hint}`;
            }
          }
        }
      } catch {
        /* best-effort */
      }
      if (nextActionHint) {
        const message = `已成功调用过 ${targetName}；场景合同工具尚未完成，禁止继续探活/重复盘点。\n\n${nextActionHint}`;
        const observation = {
          level: "warn" as const,
          toolGovernance: true,
          code: "SCENARIO_STALL_TOOL_BLOCKED",
          toolName: targetName,
          fingerprint: requestFingerprint,
          message,
          recovery: {
            nextAction: "switch_tool" as const,
            allowSameToolRetry: false,
            guidance: message,
          },
        };
        emit({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          role: state.agentDefinition.role,
          type: "observe",
          stepIndex: state.iteration,
          ts: Date.now(),
          payload: observation,
        });
        return {
          toolCalls: [
            ...state.toolCalls,
            {
              toolCallId,
              toolName: targetName,
              status: "deduplicated",
              fingerprint: requestFingerprint,
              stepIndex: state.iteration,
              completedAt: Date.now(),
              reason: message,
            },
          ],
          observations: [...state.observations, observation],
          noProgressRetryCount: 0,
        };
      }

      // Always block after stall budget even without next-action hint.
      {
        const message = `已成功调用过 ${targetName}；场景合同工具尚未完成，禁止继续探活/重复盘点。${
          nextActionHint ? `\n\n${nextActionHint}` : ""
        }`;
        const observation = {
          level: "warn" as const,
          toolGovernance: true,
          code: "SCENARIO_STALL_TOOL_BLOCKED",
          toolName: targetName,
          fingerprint: requestFingerprint,
          message,
          recovery: {
            nextAction: "switch_tool" as const,
            allowSameToolRetry: false,
            guidance: message,
          },
        };
        emit({
          runId: state.runId,
          workflowId: state.workflowId,
          traceId: state.traceId,
          role: state.agentDefinition.role,
          type: "observe",
          stepIndex: state.iteration,
          ts: Date.now(),
          payload: observation,
        });
        return {
          toolCalls: [
            ...state.toolCalls,
            {
              toolCallId,
              toolName: targetName,
              status: "deduplicated",
              fingerprint: requestFingerprint,
              stepIndex: state.iteration,
              completedAt: Date.now(),
              reason: message,
            },
          ],
          observations: [...state.observations, observation],
          noProgressRetryCount: 0,
        };
      }
    }
  }

  const reusableCall = findReusableSuccessfulToolCall({
    targetName,
    fingerprint: requestFingerprint,
    priorToolCalls: state.toolCalls,
  });
  if (reusableCall) {
    const noProgressRetryCount = (state.noProgressRetryCount ?? 0) + 1;
    const priorStep = reusableCall.stepIndex ?? "earlier";
    let message = `已在本任务第 ${priorStep} 步成功取得相同 ${targetName} 请求的结果，禁止原样重复调用。请基于已有结果继续分析、调用尚未执行的工具，或用 tool=none 汇总。`;
    let nextActionHint: string | null = null;
    try {
      const snapshot = resolveSharedSnapshot(state);
      if (snapshot?.scenarioKey) {
        const requiredTools = getScenarioExpectation(snapshot.scenarioKey).requiredTools;
        const { notAttempted } = assessRequiredToolGate({
          requiredTools,
          authorizedTools: snapshot.authorizedTools,
          attemptedTools: snapshot.attemptedTools,
          runnableTools: availableTools,
          unavailableManifestTools: [],
          market: "UNKNOWN",
        });
        nextActionHint = buildRequiredToolNextActionHint({ notAttempted });
        if (!nextActionHint && !snapshot.artifactsOk) {
          nextActionHint = [
            "## 合同工具已调用但必备产物仍缺失",
            buildArtifactGapHint({
              ok: false,
              missing: snapshot.missingArtifacts,
              scenario: snapshot.scenarioKey,
            } as never),
            "禁止重复已成功工具；请调用上方恢复顺序中的写工具补齐产物。",
          ].join("\n");
        }
        if (nextActionHint) {
          message = `${message}\n\n${nextActionHint}`;
        }
      }
    } catch {
      /* best-effort redirect; fall through to default no-progress handling */
    }
    const observation = {
      level: "warn" as const,
      toolGovernance: true,
      code: "DUPLICATE_SUCCESSFUL_TOOL_CALL",
      toolName: targetName,
      fingerprint: requestFingerprint,
      reusedToolCallId: reusableCall.toolCallId ?? null,
      message,
      recovery: {
        nextAction: (nextActionHint ? "switch_tool" : "continue_with_limits") as
          | "switch_tool"
          | "continue_with_limits",
        allowSameToolRetry: false,
        guidance: message,
      },
    };
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: observation,
    });
    // If contract tools are still missing, do not terminate as no_progress —
    // force another reason turn with an explicit next-action checklist.
    const shouldTerminate = !nextActionHint && shouldTerminateForNoProgress(noProgressRetryCount);
    return {
      toolCalls: [
        ...state.toolCalls,
        {
          toolCallId,
          toolName: targetName,
          status: "deduplicated",
          fingerprint: requestFingerprint,
          reusedToolCallId: reusableCall.toolCallId ?? null,
          stepIndex: state.iteration,
          completedAt: Date.now(),
          reason: message,
        },
      ],
      observations: [...state.observations, observation],
      ...(shouldTerminate
        ? {
            finalResponse: {
              status: "partial",
              reason: "no_progress_repeated_tool_calls",
              iteration: state.iteration,
              answerText:
                "已连续重复请求同一份已验证数据，系统已停止空转。请基于已有证据汇总，或在新任务中明确变更标的、时间范围、数据源或时间粒度。",
            },
          }
        : { noProgressRetryCount: nextActionHint ? 0 : noProgressRetryCount }),
    };
  }

  /**
   * An A2A re-dispatch starts with a fresh GraphState, so in-memory toolCalls
   * cannot see earlier evidence. Consult the workflow ledger before executing
   * the same canonical request again and inject the retained result directly.
   */
  const reusableArtifact = await findWorkflowArtifactByFingerprint(
    state.workflowId,
    requestFingerprint
  );
  if (reusableArtifact) {
    if (reusableArtifact.kind === "DataGap") {
      const knownGap = reusableArtifact.payload.dataGap;
      const message = `本 workflow 已确认 ${targetName} 的数据缺口：${JSON.stringify(knownGap)}。禁止原样重试；请切换可用能力或基于现有证据交付。`;
      const observation = {
        level: "warn" as const,
        workflowArtifactReuse: true,
        code: "WORKFLOW_DATA_GAP_REUSED",
        artifactId: reusableArtifact.id,
        dataGap: knownGap,
        message,
        recovery: {
          nextAction: "switch_tool" as const,
          allowSameToolRetry: false,
          guidance: message,
        },
      };
      emit({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        role: state.agentDefinition.role,
        type: "observe",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: observation,
      });
      return {
        toolCalls: [
          ...state.toolCalls,
          {
            toolCallId,
            toolName: targetName,
            status: "governance_blocked",
            fingerprint: requestFingerprint,
            artifactId: reusableArtifact.id,
            stepIndex: state.iteration,
            completedAt: Date.now(),
            reason: message,
          },
        ],
        observations: [...state.observations, observation],
      };
    }
    const message = `已复用本 workflow 的 ${reusableArtifact.kind}（由任务 ${reusableArtifact.producerTaskId ?? "unknown"} 产出），不重复调用 ${targetName}。请使用该事实继续分析或汇总。`;
    const observation = {
      level: "info" as const,
      workflowArtifactReuse: true,
      code: "WORKFLOW_ARTIFACT_REUSED",
      artifactId: reusableArtifact.id,
      artifactKind: reusableArtifact.kind,
      toolName: targetName,
      asOf: reusableArtifact.asOf,
      freshnessMs: reusableArtifact.freshnessMs,
      message,
      ...reusableArtifact.payload,
    };
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: observation,
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        {
          toolCallId,
          toolName: targetName,
          status: "reused_workflow_artifact",
          fingerprint: requestFingerprint,
          artifactId: reusableArtifact.id,
          stepIndex: state.iteration,
          completedAt: Date.now(),
          reason: message,
        },
      ],
      observations: [...state.observations, observation],
      workingMemory: applyToolResultToWorkingMemory(state.workingMemory, {
        step: state.iteration,
        tool: targetName,
        ok: true,
        result: reusableArtifact.payload,
        oneLiner: `${targetName} reused workflow artifact ${reusableArtifact.id}`,
      }),
      noProgressRetryCount: 0,
    };
  }

  if (
    isRedundantTopologyProbe({
      taskType,
      targetName,
      priorToolCalls: state.toolCalls,
    })
  ) {
    const message =
      `本轮已成功调用 ${targetName}，禁止重复健康探测。` +
      "若核心业务数据已取得，请立即用 tool=none 汇总；否则直接调用尚未执行的业务工具。";
    const observation = {
      level: "warn",
      toolGovernance: true,
      code: "REDUNDANT_TOPOLOGY_PROBE",
      message,
      recovery: {
        nextAction: "continue_with_limits",
        allowSameToolRetry: false,
        guidance: message,
      },
    };
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: observation,
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        { toolName: targetName, status: "governance_blocked", reason: message },
      ],
      observations: [...state.observations, observation],
    };
  }

  // Coding-Agent 体验 P1（docs/CODING_AGENT_EXPERIENCE_DESIGN.md）：把「调用理由」露给用户。
  // 取 reason 文本里约定的 `调用理由：…` 一行；仅 SSE 事件，不污染最终答复。best-effort。
  const rationaleMatch = (state.reasonText ?? "").match(/调用理由[:：]\s*(.+)/);
  const rationaleWhy = (rationaleMatch?.[1] ?? "").trim().slice(0, 280);
  if (rationaleWhy) {
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "tool_rationale",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: { toolName, targetName, why: rationaleWhy },
    });
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
    requestFingerprint,
    reasonText: state.reasonText ?? "",
    contextMemory: state.contextMemory,
    ...(capabilityGateAllowed || toolContractName
      ? {
          governance: {
            ...(capabilityGateAllowed ? { capabilityGate: "allowed" } : {}),
            ...(toolContractName ? { contractName: toolContractName } : {}),
          },
        }
      : {}),
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
  const execution = await executeAdmittedTool({
    state,
    plan: toolPlan,
    params: enrichedToolParams,
    projectId,
    agentInstanceId,
    agentStepId,
    toolCallId,
    gateTimeoutMs,
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
      workingMemory: applyToolResultToWorkingMemory(state.workingMemory, {
        step: state.iteration,
        tool: targetName,
        ok: false,
        errorMessage: execution.result.reason ?? "tool timeout",
      }),
    };
  }

  const execValue = execution.value as {
    result?: string;
    toolError?: boolean;
    errorSource?: "mcp" | "connector" | "builtin" | "unknown";
    errorMessage?: string;
  };
  const semanticFailure = detectSemanticToolFailure(targetName, execution.value);
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
  if ((execValue.result === "error" && execValue.toolError) || semanticFailure) {
    const latencyMs = Date.now() - startedAt;
    const errMsg = semanticFailure
      ? `semantic_data_failure:${semanticFailure}`
      : (execValue.errorMessage ?? "tool call failed");
    const errorSource = semanticFailure
      ? mcp
        ? "mcp"
        : connectorTarget
          ? "connector"
          : "builtin"
      : (execValue.errorSource ?? "unknown");
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
    const dataGap = classifyDataGap({
      toolName: targetName,
      params:
        mcp && mcp.arguments && typeof mcp.arguments === "object" && !Array.isArray(mcp.arguments)
          ? (mcp.arguments as Record<string, unknown>)
          : enrichedToolParams,
      message: errMsg,
    });
    if (dataGap) {
      void recordWorkflowDataGap({
        workflowRunId: state.workflowId,
        fingerprint: requestFingerprint,
        toolName: targetName,
        gap: dataGap,
        producerTaskId: typeof inboundPayload.taskId === "string" ? inboundPayload.taskId : null,
      }).catch(() => {});
    }
    recordWorkflowToolFailure({
      workflowId: state.workflowId,
      targetName,
      params: mcp ? mcp.arguments : enrichedToolParams,
      reason: errMsg,
      cacheable: Boolean(semanticFailure) || errorClass === "blocked" || errorClass === "permanent",
    });
    const recovery = buildToolRecoveryPlan({
      failedTool: targetName,
      availableTools,
      priorToolCalls: state.toolCalls,
      errorClass,
      semanticFailure: Boolean(semanticFailure),
      workflowId: state.workflowId,
      params: mcp ? mcp.arguments : enrichedToolParams,
    });
    const retryable = recovery.allowSameToolRetry;
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
        ...(dataGap ? { dataGap } : {}),
        retryable,
        hint: `${hint} ${recovery.guidance}`,
        recovery,
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
          ...(dataGap ? { dataGap } : {}),
          retryable,
          hint: `${hint} ${recovery.guidance}`,
          recovery,
          reasonText: state.reasonText,
        },
      ],
      workingMemory: applyToolResultToWorkingMemory(state.workingMemory, {
        step: state.iteration,
        tool: targetName,
        ok: false,
        errorMessage: errMsg,
      }),
    };
  }

  const latencyMs = Date.now() - startedAt;
  await recordToolCallSuccess({
    toolCallId,
    hasMcp: Boolean(mcp),
    latencyMs,
    responsePayload: execution.value as Record<string, unknown>,
  });

  /**
   * Wave-1（2026-06-10）：自动 mark recalled skill 为 executed。
   *
   * 旧链路靠 LLM 主动调 `skill.use_record(skillId)` 翻 executed=true，实测命中率
   * 接近 0（参见 auto-skill-execution-hook.ts JSDoc）。这里改成 fire-and-forget：
   * tool call 成功后扫一遍 skill_recall_log，对 body 包含本次 tool / server 名的
   * skill 自动标记。完全不阻塞 graph 主流。
   */
  void autoMarkRecalledSkillsAsExecuted({
    workflowRunId: state.workflowId,
    toolName: targetName,
    mcpServerName: mcp?.serverName ?? null,
    definitionId: state.agentDefinition.id ?? null,
  }).catch(() => {
    /** hook 自身已 try/catch + warn，这里再兜底防止未捕获 rejection */
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

  const toolResult: Record<string, unknown> =
    execution.ok && execution.value && typeof execution.value === "object"
      ? (execution.value as Record<string, unknown>)
      : {};
  const producerTaskId =
    typeof inboundPayload.taskId === "string" && inboundPayload.taskId.trim()
      ? inboundPayload.taskId
      : null;
  try {
    await recordWorkflowToolArtifact({
      workflowRunId: state.workflowId,
      fingerprint: requestFingerprint,
      toolName: targetName,
      result: toolResult,
      producerTaskId,
    });
  } catch (error) {
    // Ledger is a reuse accelerator, not a reason to turn an otherwise valid
    // tool response into a failed research task.
    console.warn(
      `[act] workflow artifact write skipped for ${targetName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const nextObservations = [...state.observations];
  if (toolResult["analystTeamResult"]) {
    nextObservations.push({
      analystTeamResult: compactToolObservationValue(
        targetName,
        toolResult["analystTeamResult"]
      ),
    });
  }
  if (toolResult["mcpResult"]) {
    nextObservations.push({
      mcpResult: compactToolObservationValue(targetName, toolResult["mcpResult"]),
    });
  }
  if (toolResult["connectorResult"] !== undefined) {
    nextObservations.push({
      connectorResult: compactToolObservationValue(targetName, toolResult["connectorResult"]),
    });
  }
  if (toolResult["packEdit"]) {
    nextObservations.push({ packEdit: toolResult["packEdit"] });
  }
  if (toolResult["builtinResult"]) {
    nextObservations.push({
      builtinResult: compactToolObservationValue(targetName, toolResult["builtinResult"]),
    });
  }
  if (toolResult["fusionResult"]) {
    nextObservations.push({ fusionResult: toolResult["fusionResult"] });
  }

  // Arrays returned directly by connectors (e.g. fetch_klines → BarData[]) don't have
  // a connectorResult key; still shrink them for the next reason call.
  if (
    Array.isArray(execution.value) &&
    !toolResult["connectorResult"] &&
    !toolResult["builtinResult"] &&
    !toolResult["mcpResult"]
  ) {
    nextObservations.push({
      tool: targetName,
      connectorResult: compactToolObservationValue(targetName, execution.value),
    });
  }

  // After a successful call, if scenario contract tools remain not_attempted,
  // push an explicit next-action so the model does not burn the budget on
  // another screener/list/readiness probe.
  try {
    const snapshot = resolveSharedSnapshot(state);
    if (snapshot?.scenarioKey) {
      const requiredTools = getScenarioExpectation(snapshot.scenarioKey).requiredTools;
      const attemptedTools = [...new Set([...snapshot.attemptedTools, targetName])];
      const { notAttempted } = assessRequiredToolGate({
        requiredTools,
        authorizedTools: snapshot.authorizedTools,
        attemptedTools,
        runnableTools: availableTools,
        unavailableManifestTools: [],
        market: "UNKNOWN",
      });
      const hint = buildRequiredToolNextActionHint({ notAttempted });
      if (hint) {
        nextObservations.push({
          level: "warn",
          code: "REQUIRED_TOOL_NEXT_ACTION",
          scenario: snapshot.scenarioKey,
          afterTool: targetName,
          hint,
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
            level: "warn",
            code: "REQUIRED_TOOL_NEXT_ACTION",
            scenario: snapshot.scenarioKey,
            afterTool: targetName,
            message: hint,
          },
        });
      }
    }
  } catch {
    /* best-effort */
  }

  return {
    toolCalls: [
      ...state.toolCalls,
      {
        toolCallId,
        toolName: targetName,
        status: "success",
        fingerprint: requestFingerprint,
        stepIndex: state.iteration,
        completedAt: Date.now(),
      },
    ],
    observations: nextObservations,
    workingMemory: applyToolResultToWorkingMemory(state.workingMemory, {
      step: state.iteration,
      tool: targetName,
      ok: true,
      result: toolResult,
      oneLiner: `${targetName} ok (${latencyMs}ms)`,
    }),
    // 成功推进后清零“连续提前结束”计数，避免长 Goal 因早期一次试探性收口被累计误杀。
    controlModeGapRetryCount: 0,
    noProgressRetryCount: 0,
  };
}
