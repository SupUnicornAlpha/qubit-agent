import { eq } from "drizzle-orm";
import { registerBuiltinConnectors } from "../../../connectors/bootstrap";
import { connectorRegistry } from "../../../connectors/registry";
import { getDb, getSqliteForTesting } from "../../../db/sqlite/client";
import { workflowRun } from "../../../db/sqlite/schema";
import { resolveAgentControlMode, resolveWorkflowProcessConfig } from "../../../types/loop";
import {
  buildArtifactGapHint,
  checkRequiredArtifacts,
  resolveScenarioKey,
} from "../../agent-readiness/quality/artifact-checker";
import { getScenarioExpectation } from "../../agent-readiness/quality/scenario-expectations";
import { buildAcpRequest, defaultAcpCaller } from "../../../messaging/acp";
import { dispatchMcpToolCall } from "../../mcp/dispatcher";
import { resolveEffectiveAgentTools } from "../../orchestration/resolve-effective-tools";
import {
  isRedundantTopologyProbe,
  resolveTopologyToolTimeoutMs,
} from "../../orchestration/topology-dispatch";
import {
  assessGoalPlanCompletion,
  isToolAllowedInAgentControlMode,
  parseAgentPlanSnapshot,
} from "../../agent-control-mode";
import { logResearchTeamInteraction } from "../../research-team/interaction-log";
import { sandboxExecutor } from "../../sandbox-executor";
import { autoMarkRecalledSkillsAsExecuted } from "../../skills/auto-skill-execution-hook";
import { dispatchBuiltinTool, isBuiltinTool } from "../../tools/builtin-tools";
import { authorizeCapability, isCapabilityGateEnabled } from "../../tools/capability-gate";
import { injectContextParams } from "../../tools/context-params";
import {
  buildRuntimeCapabilityManifestForRuntime,
  isToolBlockedByRuntimeCapability,
} from "../../tools/data-capability-manifest";
import {
  buildNotAttemptedDataGaps,
  classifyDataGap,
  toolMatchesRequiredCapability,
} from "../../tools/data-gap";
import { parseToolCallFromReason, stripToolCallSentinels } from "../../tools/tool-call-format";
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
import {
  recordToolCallError,
  recordToolCallSandboxBlocked,
  recordToolCallStart,
  recordToolCallSuccess,
  recordToolCallTimeout,
} from "../../tools/tool-call-log-service";
import { detectSemanticToolFailure } from "../../tools/semantic-tool-result";
import {
  evaluateToolGovernance,
  recordWorkflowToolFailure,
} from "../../tools/tool-governance-policy";
import {
  resolveToolExecutionRoute,
  toolRouteToTargetKind,
  toolRouteToToolKind,
} from "../../tools/tool-dispatch-resolver";
import { applyToolContract, isToolContractEnabled } from "../../tools/tool-contract";
import { getToolContract } from "../../tools/tool-contract-registry";
import { resolveConnectorForServerAlias } from "../../tools/tool-routes";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { buildMcpRetryHint, classifyToolError } from "./tool-error-classifier";
import { buildToolRecoveryPlan } from "./tool-recovery-policy";
import {
  assessWorkflowProcessGate,
  resolveEffectiveWorkflowProcessConfig,
} from "../../workflow/process-config";

/**
 * P2 优先级（Round 7 复盘 2026-06-08）：artifact gate 最多 push back 几次。
 *
 * 触发：LLM 输出 `{"tool":"none"}` 想停机 + scenario 的 requiredArtifacts 还没满足。
 * 上限 2：第 1/2 次把 hint 塞回 observation 让 graph 回 reason 再跑；第 3 次仍未
 * 补齐则以 artifact_gate_unsatisfied 明确失败。禁止缺产物却写 completed；同时保留
 * 面向用户的失败答复，让客户端知道缺什么、为什么无法继续。
 *
 * 同时受 def.maxIterations 上限保护（execute-agent-react.ts:438）—— 即便 gate 想 push back
 * 但已到 max iteration，graph 会自然 finalize。
 */
const MAX_ARTIFACT_GATE_RETRIES = 2;
const MAX_CONTROL_MODE_GATE_RETRIES = 2;
const MAX_REQUIRED_TOOL_GATE_RETRIES = 1;

export async function actNode(
  state: AgentGraphState,
  emit: (event: StepStreamEvent) => void,
  agentInstanceId: string,
  agentStepId: string
): Promise<Partial<AgentGraphState>> {
  const db = await getDb();
  const workflowRows = await db
    .select({
      projectId: workflowRun.projectId,
      loopOptionsJson: workflowRun.loopOptionsJson,
      planJson: workflowRun.planJson,
    })
    .from(workflowRun)
    .where(eq(workflowRun.id, state.workflowId))
    .limit(1);
  const projectId = workflowRows[0]?.projectId;
  const agentMode = resolveAgentControlMode(workflowRows[0]?.loopOptionsJson);
  const processConfig = resolveEffectiveWorkflowProcessConfig(
    resolveWorkflowProcessConfig(workflowRows[0]?.loopOptionsJson),
    agentMode
  );
  const planSnapshot = workflowRows[0]?.planJson;
  const effective = await resolveEffectiveAgentTools(state.agentDefinition, state.workflowId);
  const availableTools = effective.tools;
  const parsed = parseToolCallFromReason(state.reasonText ?? "", availableTools);

  if (parsed.kind === "none") {
    const cleanedReason = stripToolCallSentinels(state.reasonText ?? "");
    const summary = parsed.summary?.trim() || cleanedReason.slice(0, 2000) || "no tool requested";

    if (state.agentDefinition.role === "orchestrator" && agentMode !== "agent") {
      const parsedPlan = parseAgentPlanSnapshot(planSnapshot);
      const goalAssessment =
        agentMode === "goal"
          ? assessGoalPlanCompletion(planSnapshot)
          : {
              ok: Boolean(parsedPlan?.steps.length),
              code: "missing_plan" as const,
              message: "Plan 模式必须先调用 update_plan 保存可执行计划，再返回给用户。",
              pendingStepIds: [] as string[],
            };
      const hasExecutionEvidence =
        agentMode !== "goal" ||
        state.toolCalls.some(
          (call) =>
            call.status === "success" &&
            call.toolName !== "update_plan" &&
            call.toolName !== "tool/update_plan"
        );
      const gateOk = goalAssessment.ok && hasExecutionEvidence;
      if (!gateOk) {
        const retryCount = state.controlModeGapRetryCount ?? 0;
        const message = !goalAssessment.ok
          ? goalAssessment.message
          : "Goal 模式尚无业务工具或专家执行成功的验证证据，不能仅更新计划后直接结束。";
        if (retryCount < MAX_CONTROL_MODE_GATE_RETRIES) {
          const observation = {
            level: "warn",
            controlModeGate: true,
            code:
              agentMode === "plan"
                ? "PLAN_REQUIRED"
                : hasExecutionEvidence
                  ? "GOAL_PLAN_INCOMPLETE"
                  : "GOAL_EVIDENCE_REQUIRED",
            agentMode,
            pendingStepIds: goalAssessment.pendingStepIds,
            retryCount: retryCount + 1,
            maxRetries: MAX_CONTROL_MODE_GATE_RETRIES,
            message,
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
            observations: [...state.observations, observation],
            controlModeGapRetryCount: retryCount + 1,
          };
        }
        const answerText = [
          `${agentMode === "plan" ? "计划生成" : "目标执行"}未通过完成门禁：${message}`,
          cleanedReason ? `当前说明：\n${cleanedReason}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          observations: [
            ...state.observations,
            {
              level: "error",
              controlModeGate: true,
              code: "CONTROL_MODE_GATE_UNSATISFIED",
              agentMode,
              message,
            },
          ],
          finalResponse: {
            status: "terminated",
            reason: "control_mode_gate_unsatisfied",
            error: message,
            answerText,
            iteration: state.iteration,
            role: state.agentDefinition.role,
          },
        };
      }
    }

    if (state.agentDefinition.role === "orchestrator" && processConfig) {
      const successfulBusinessToolCalls = state.toolCalls.filter(
        (call) =>
          call.status === "success" &&
          call.toolName !== "update_plan" &&
          call.toolName !== "tool/update_plan"
      ).length;
      const processGate = assessWorkflowProcessGate({
        config: processConfig,
        plan: parseAgentPlanSnapshot(planSnapshot),
        successfulBusinessToolCalls,
      });
      if (!processGate.ok) {
        const retryCount = state.controlModeGapRetryCount ?? 0;
        const message = processGate.reasons.join(" ");
        if (retryCount < MAX_CONTROL_MODE_GATE_RETRIES) {
          const observation = {
            level: "warn",
            workflowProcessGate: true,
            code: "WORKFLOW_PROCESS_GATE_PENDING",
            retryCount: retryCount + 1,
            maxRetries: MAX_CONTROL_MODE_GATE_RETRIES,
            message,
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
            observations: [...state.observations, observation],
            controlModeGapRetryCount: retryCount + 1,
          };
        }
        return {
          observations: [
            ...state.observations,
            {
              level: "error",
              workflowProcessGate: true,
              code: "WORKFLOW_PROCESS_GATE_UNSATISFIED",
              message,
            },
          ],
          finalResponse: {
            status: "terminated",
            reason: "workflow_process_gate_unsatisfied",
            error: message,
            answerText: `流程完成门禁未通过：${message}`,
            iteration: state.iteration,
            role: state.agentDefinition.role,
          },
        };
      }
    }

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
      const requiredTools = getScenarioExpectation(scenarioKey).requiredTools;
      const terminalPayload = state.inboundMessage.payload as Record<string, unknown>;
      const terminalTicker =
        typeof terminalPayload.ticker === "string"
          ? terminalPayload.ticker
          : typeof terminalPayload.symbol === "string"
            ? terminalPayload.symbol
            : null;
      const terminalManifest = await buildRuntimeCapabilityManifestForRuntime({
        tools: availableTools,
        goal: typeof terminalPayload.goal === "string" ? terminalPayload.goal : null,
        ticker: terminalTicker,
      });
      const unavailableRequired = requiredTools.flatMap((capability) => {
        const runnable = terminalManifest.tools.some((toolName) =>
          toolMatchesRequiredCapability(toolName, capability)
        );
        if (runnable) return [];
        const blocked = terminalManifest.unavailable.find((entry) =>
          toolMatchesRequiredCapability(entry.toolName, capability)
        );
        return [
          {
            kind: blocked?.status === "no_coverage" ? "no_coverage" : "unconfigured",
            capability,
            market: terminalManifest.market,
            provider: blocked?.provider ?? null,
            reason:
              blocked?.reason ??
              `当前 Agent 的已授权工具集中没有可完成 ${capability} 的工具；这不是“无数据”。`,
            retryable: false,
          } as const,
        ];
      });
      const attemptableRequired = requiredTools.filter((capability) =>
        terminalManifest.tools.some((toolName) =>
          toolMatchesRequiredCapability(toolName, capability)
        )
      );
      const notAttempted = buildNotAttemptedDataGaps({
        requiredCapabilities: attemptableRequired,
        attemptedTools: state.toolCalls.map((call) => String(call.toolName ?? "")),
        market: terminalManifest.market,
      });
      const requiredToolRetryCount = state.requiredToolGapRetryCount ?? 0;
      if (notAttempted.length > 0 && requiredToolRetryCount < MAX_REQUIRED_TOOL_GATE_RETRIES) {
        const message = `场景必备能力尚未调用：${notAttempted
          .map((gap) => gap.capability)
          .join("、")}。这属于 not_attempted，不能作为“无数据”结束；请先调用一个可用的对应工具。`;
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
            code: "REQUIRED_TOOL_GATE_NOT_ATTEMPTED",
            scenario: scenarioKey,
            dataGaps: [...notAttempted, ...unavailableRequired],
            retryCount: requiredToolRetryCount + 1,
            maxRetries: MAX_REQUIRED_TOOL_GATE_RETRIES,
            message,
          },
        });
        return {
          observations: [
            ...state.observations,
            {
              level: "warn",
              code: "REQUIRED_TOOL_GATE_NOT_ATTEMPTED",
              scenario: scenarioKey,
              dataGaps: [...notAttempted, ...unavailableRequired],
              hint: message,
            },
          ],
          requiredToolGapRetryCount: requiredToolRetryCount + 1,
        };
      }
      if (notAttempted.length > 0) {
        const message = `场景必备能力在补救后仍未调用：${notAttempted
          .map((gap) => gap.capability)
          .join("、")}。系统仅交付当前已有证据，不能标记为 completed。`;
        return {
          observations: [
            ...state.observations,
            {
              level: "warn",
              code: "REQUIRED_TOOL_GATE_UNSATISFIED",
              scenario: scenarioKey,
              dataGaps: [...notAttempted, ...unavailableRequired],
              hint: message,
            },
          ],
          finalResponse: {
            status: "partial",
            reason: "required_tool_gate_unsatisfied",
            answerText: message,
            iteration: state.iteration,
            role: state.agentDefinition.role,
          },
        };
      }
      if (unavailableRequired.length > 0) {
        const message = `场景所需能力当前不可用：${unavailableRequired
          .map((gap) => `${gap.capability}（${gap.kind}）`)
          .join("、")}。系统不会把未配置或无覆盖误报为无数据。`;
        return {
          observations: [
            ...state.observations,
            {
              level: "warn",
              code: "REQUIRED_TOOL_CAPABILITY_UNAVAILABLE",
              scenario: scenarioKey,
              dataGaps: unavailableRequired,
              hint: message,
            },
          ],
          finalResponse: {
            status: "partial",
            reason: "required_tool_capability_unavailable",
            answerText: message,
            iteration: state.iteration,
            role: state.agentDefinition.role,
          },
        };
      }
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
      if (!gate.ok) {
        const hint = buildArtifactGapHint(gate);
        const missing = gate.missing.map((m) => `${m.table}=${m.rows}/${m.minRows}`).join(", ");
        const answerText = [
          `任务未能完成：必需产物在 ${MAX_ARTIFACT_GATE_RETRIES} 次修复后仍不完整（${missing}）。`,
          "系统不会用空数据或模拟结果冒充成功。请恢复可用数据源后重试。",
          cleanedReason && cleanedReason !== "no tool requested"
            ? `当前可交付说明：\n${cleanedReason}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n");
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
            code: "ARTIFACT_GATE_UNSATISFIED",
            scenario: scenarioKey,
            missing: gate.missing,
            message: hint,
          },
        });
        return {
          observations: [
            ...state.observations,
            {
              level: "error",
              code: "ARTIFACT_GATE_UNSATISFIED",
              scenario: scenarioKey,
              missing: gate.missing,
              hint,
            },
          ],
          finalResponse: {
            status: "terminated",
            reason: "artifact_gate_unsatisfied",
            error: hint,
            answerText,
            iteration: state.iteration,
            role: state.agentDefinition.role,
          },
        };
      }
    }

    if (state.agentDefinition.role === "orchestrator" && agentMode === "goal") {
      const completedPlan = parseAgentPlanSnapshot(planSnapshot);
      if (completedPlan?.goal) {
        const evidenceCount = state.toolCalls.filter(
          (call) =>
            call.status === "success" &&
            call.toolName !== "update_plan" &&
            call.toolName !== "tool/update_plan"
        ).length;
        const completedAt = new Date().toISOString();
        await db
          .update(workflowRun)
          .set({
            planJson: {
              ...completedPlan,
              goal: {
                ...completedPlan.goal,
                status: "completed",
                verification: {
                  evidenceCount,
                  summary: summary.slice(0, 1000),
                  verifiedAt: completedAt,
                },
              },
              updatedAt: completedAt,
            } as never,
          })
          .where(eq(workflowRun.id, state.workflowId));
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
        /**
         * answerText = 完整去 sentinel 的 reason 文本（即 LLM 面向用户的自然语言答复）。
         * summary 可能只是 LLM 自带的「为何不调工具」式摘要句，不一定是实质答案；
         * orchestrator_chat 落库 orchestrator→user 时优先用 answerText 取完整答复。
         */
        answerText: cleanedReason || summary,
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
  /**
   * 治理 #2：上下文绑定参数（workflowRunId / projectId）由 harness 在
   * resolve 出权威 projectId 后用 injectContextParams 无条件注入（见 line ~290）。
   * 这里先按 LLM 原始 params 起步；连 connector-alias rewrite 分支也只动业务参数。
   */
  let enrichedToolParams: Record<string, unknown> = { ...toolParams };

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
   * Runtime 4.5：统一工具路由（alias → builtin 优先 → connector）。
   * MCP connector 别名改写仍在上面的 block 完成。
   */
  const executionRoute = mcp ? null : resolveToolExecutionRoute(effectiveToolName);
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
    effectiveToolName = executionRoute.effectiveName;
  }

  const connectorTarget =
    !mcp && executionRoute?.route === "connector" ? executionRoute.connectorName : undefined;
  const targetKind: "mcp" | "tool" | "connector" = mcp
    ? "mcp"
    : toolRouteToTargetKind(executionRoute?.route ?? "builtin");
  const targetName = mcp
    ? `${mcp.serverName}/${mcp.toolName}`
    : connectorTarget
      ? `${connectorTarget}/${effectiveToolName}`
      : effectiveToolName;
  const toolKind = mcp ? "mcp" : toolRouteToToolKind(executionRoute?.route ?? "builtin");
  const toolCallId = crypto.randomUUID();
  const inboundPayload = state.inboundMessage.payload as Record<string, unknown>;
  const taskType = String(inboundPayload.taskType ?? "");
  /**
   * 治理 #2（取代 F-P0-12 的 isLikelyProjectIdFormat 启发式补丁）：
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
  enrichedToolParams = injectContextParams(enrichedToolParams, {
    workflowRunId: state.workflowId,
    projectId,
  });

  const runtimeCapabilityManifest = await buildRuntimeCapabilityManifestForRuntime({
    tools: [targetName],
    goal:
      typeof inboundPayload.goal === "string"
        ? inboundPayload.goal
        : typeof enrichedToolParams.goal === "string"
          ? enrichedToolParams.goal
          : null,
    ticker:
      typeof enrichedToolParams.ticker === "string"
        ? enrichedToolParams.ticker
        : typeof enrichedToolParams.symbol === "string"
          ? enrichedToolParams.symbol
          : null,
    symbol: typeof enrichedToolParams.symbol === "string" ? enrichedToolParams.symbol : null,
    exchange: typeof enrichedToolParams.exchange === "string" ? enrichedToolParams.exchange : null,
  });
  const capabilityUnavailable = isToolBlockedByRuntimeCapability(
    runtimeCapabilityManifest,
    targetName
  );
  if (capabilityUnavailable) {
    const gap = {
      kind: capabilityUnavailable.status === "unconfigured" ? "unconfigured" : "no_coverage",
      market: runtimeCapabilityManifest.market,
      capability: targetName,
      provider: targetName.includes("/") ? (targetName.split("/", 1)[0] ?? null) : null,
      reason: capabilityUnavailable.reason,
      retryable: false,
    } as const;
    const unavailableFingerprint = buildToolCallFingerprint({
      targetName,
      params:
        mcp && mcp.arguments && typeof mcp.arguments === "object" && !Array.isArray(mcp.arguments)
          ? (mcp.arguments as Record<string, unknown>)
          : enrichedToolParams,
    });
    void recordWorkflowDataGap({
      workflowRunId: state.workflowId,
      fingerprint: unavailableFingerprint,
      toolName: targetName,
      gap,
      producerTaskId: typeof inboundPayload.taskId === "string" ? inboundPayload.taskId : null,
    }).catch(() => {});
    const observation = {
      level: "warn" as const,
      toolGovernance: true,
      capabilityManifest: true,
      code: capabilityUnavailable.code,
      dataGap: gap,
      message: capabilityUnavailable.reason,
      recovery: {
        nextAction: "switch_tool" as const,
        allowSameToolRetry: false,
        guidance: "请改用已展示的可用工具，或明确配置该市场的实时数据 provider。",
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
          reason: capabilityUnavailable.reason,
        },
      ],
      observations: [...state.observations, observation],
    };
  }

  /** CapabilityGate (docs/agent-contracts/02) — authorize before sandbox/execute. */
  let gateTimeoutMs: number | undefined;
  let capabilityGateAllowed = false;
  let toolContractName: string | undefined;
  if (isCapabilityGateEnabled()) {
    const gate = await authorizeCapability({
      name: effectiveToolName,
      agentDefinition: state.agentDefinition,
      workflowId: state.workflowId,
      ...(projectId ? { projectId } : {}),
      ...(agentMode ? { agentMode } : {}),
      ...(mcp ? { isMcp: true, serverName: mcp.serverName, mcpTool: mcp.toolName } : {}),
    });
    if (!gate.ok) {
      const allowHint =
        gate.allowlist && gate.allowlist.length > 0
          ? ` allowed=[${gate.allowlist.join(", ")}]`
          : "";
      const reason = `${gate.message}.${allowHint} ${gate.hint}`.trim();
      const observation = {
        level: "warn" as const,
        toolGovernance: true,
        capabilityGate: true,
        code: gate.code,
        message: reason,
        recovery: {
          nextAction: "switch_tool" as const,
          allowSameToolRetry: false,
          ...(gate.allowlist ? { alternatives: gate.allowlist } : {}),
          guidance: gate.hint,
        },
      };
      /** 设计 02 §4.6：Deny 也写 tool_call_log（复用 sandbox_blocked + gate_denied 前缀）。 */
      await recordToolCallStart({
        toolCallId,
        agentStepId,
        workflowRunId: state.workflowId,
        traceId: state.traceId,
        agentDefinitionId: state.agentDefinition.id,
        targetName,
        toolKind,
        targetKind,
        ...(mcp ? { mcp } : {}),
        reasonText: state.reasonText ?? "",
        contextMemory: state.contextMemory,
        governance: { capabilityGate: "denied" },
      });
      await recordToolCallSandboxBlocked({
        toolCallId,
        hasMcp: Boolean(mcp),
        reason,
        violationType: gate.code,
        capabilityGate: true,
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
          reason,
          targetKind,
          targetName,
          capabilityGate: true,
          code: gate.code,
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
        payload: observation,
      });
      return {
        toolCalls: [
          ...state.toolCalls,
          { toolCallId, toolName: targetName, status: "governance_blocked", reason },
        ],
        observations: [...state.observations, observation],
      };
    }
    gateTimeoutMs = gate.timeoutMs;
    capabilityGateAllowed = true;
  }

  /** ToolContract (docs/agent-contracts/01) — normalize/validate registered tools. */
  if (isToolContractEnabled() && !mcp) {
    const contract = getToolContract(effectiveToolName);
    if (contract) {
      toolContractName = contract.name;
      try {
        enrichedToolParams = applyToolContract(contract, enrichedToolParams);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const observation = {
          level: "warn" as const,
          toolGovernance: true,
          toolContract: true,
          code: "TOOL_CONTRACT_VALIDATION_FAILED",
          message: reason,
          recovery: {
            nextAction: "switch_tool" as const,
            allowSameToolRetry: false,
            guidance: "请按工具契约修正参数（例如使用 symbol 或 symbols[]），不要原样重试。",
          },
        };
        /** 设计 01 P0：验参失败落 tool_call_log，errorClass 由 classifier 判 permanent。 */
        await recordToolCallStart({
          toolCallId,
          agentStepId,
          workflowRunId: state.workflowId,
          traceId: state.traceId,
          agentDefinitionId: state.agentDefinition.id,
          targetName,
          toolKind,
          targetKind,
          reasonText: state.reasonText ?? "",
          contextMemory: state.contextMemory,
          governance: {
            ...(capabilityGateAllowed ? { capabilityGate: "allowed" } : {}),
            contractName: contract.name,
            contractRejected: true,
          },
        });
        await recordToolCallError({
          toolCallId,
          hasMcp: false,
          latencyMs: 0,
          errorSource: connectorTarget ? "connector" : "builtin",
          errorMessage: reason,
          contractCode: reason.split(":", 1)[0] ?? "contract_validation_failed",
          contractRejected: true,
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
            status: "error",
            reason,
            targetKind,
            targetName,
            toolContract: true,
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
          payload: observation,
        });
        return {
          toolCalls: [
            ...state.toolCalls,
            { toolCallId, toolName: targetName, status: "governance_blocked", reason },
          ],
          observations: [...state.observations, observation],
        };
      }
    }
  }

  if (!isToolAllowedInAgentControlMode(agentMode, effectiveToolName)) {
    const reason = `Plan 模式只允许 update_plan；工具 ${targetName} 已被运行时拦截。请先形成计划，不要执行任务。`;
    const observation = {
      level: "warn",
      toolGovernance: true,
      controlModeGate: true,
      code: "PLAN_MODE_EXECUTION_BLOCKED",
      agentMode,
      message: reason,
      recovery: {
        nextAction: "switch_tool",
        allowSameToolRetry: false,
        alternatives: ["update_plan"],
        guidance: "改用 update_plan 保存计划；随后用 tool=none 返回计划说明。",
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
        { toolName: targetName, status: "governance_blocked", reason },
      ],
      observations: [...state.observations, observation],
    };
  }

  const governance = evaluateToolGovernance({
    workflowId: state.workflowId,
    targetName,
    params: mcp ? mcp.arguments : enrichedToolParams,
  });
  if (!governance.allowed) {
    const recoveryObservation = {
      level: "warn",
      toolGovernance: true,
      code: governance.code,
      market: governance.market,
      message: governance.reason,
      recovery: {
        nextAction: "switch_tool",
        allowSameToolRetry: false,
        guidance: governance.reason,
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
      payload: recoveryObservation,
    });
    return {
      toolCalls: [
        ...state.toolCalls,
        { toolName: targetName, status: "governance_blocked", reason: governance.reason },
      ],
      observations: [...state.observations, recoveryObservation],
    };
  }

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
  const reusableCall = findReusableSuccessfulToolCall({
    targetName,
    fingerprint: requestFingerprint,
    priorToolCalls: state.toolCalls,
  });
  if (reusableCall) {
    const noProgressRetryCount = (state.noProgressRetryCount ?? 0) + 1;
    const priorStep = reusableCall.stepIndex ?? "earlier";
    const message = `已在本任务第 ${priorStep} 步成功取得相同 ${targetName} 请求的结果，禁止原样重复调用。请基于已有结果继续分析、调用尚未执行的工具，或用 tool=none 汇总。`;
    const observation = {
      level: "warn" as const,
      toolGovernance: true,
      code: "DUPLICATE_SUCCESSFUL_TOOL_CALL",
      toolName: targetName,
      fingerprint: requestFingerprint,
      reusedToolCallId: reusableCall.toolCallId ?? null,
      message,
      recovery: {
        nextAction: "continue_with_limits" as const,
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
          reusedToolCallId: reusableCall.toolCallId ?? null,
          stepIndex: state.iteration,
          completedAt: Date.now(),
          reason: message,
        },
      ],
      observations: [...state.observations, observation],
      ...(shouldTerminateForNoProgress(noProgressRetryCount)
        ? {
            finalResponse: {
              status: "partial",
              reason: "no_progress_repeated_tool_calls",
              iteration: state.iteration,
              answerText:
                "已连续重复请求同一份已验证数据，系统已停止空转。请基于已有证据汇总，或在新任务中明确变更标的、时间范围、数据源或时间粒度。",
            },
          }
        : { noProgressRetryCount }),
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
  const topologyToolTimeoutMs = resolveTopologyToolTimeoutMs(effectiveToolName);
  const execution = await sandboxExecutor.enforceToolTimeout({
    runId: state.runId,
    workflowId: state.workflowId,
    traceId: state.traceId,
    agentInstanceId,
    definition: state.agentDefinition,
    ...(gateTimeoutMs !== undefined
      ? { timeoutMs: gateTimeoutMs }
      : topologyToolTimeoutMs !== undefined
        ? { timeoutMs: topologyToolTimeoutMs }
        : {}),
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
            timeoutMs: gateTimeoutMs ?? policy.maxToolCallMs,
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

  const toolResult = execution.ok && execution.value ? execution.value : {};
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
