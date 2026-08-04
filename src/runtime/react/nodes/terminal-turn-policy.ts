import { eq } from "drizzle-orm";
import { getDb } from "../../../db/sqlite/client";
import { workflowRun } from "../../../db/sqlite/schema";
import type { AgentControlMode, WorkflowProcessConfig } from "../../../types/loop";
import { parseAgentPlanSnapshot } from "../../agent-control-mode";
import { getScenarioExpectation } from "../../agent-readiness/quality/scenario-expectations";
import { decideToolNoneGate } from "../../policy";
import { buildRuntimeCapabilityManifestForRuntime } from "../../tools/data-capability-manifest";
import { assessRequiredToolGate } from "../../tools/required-tool-gate";
import { stripToolCallSentinels } from "../../tools/tool-call-format";
import type { AgentGraphState, StepStreamEvent } from "../state";
import { decideTerminalControl } from "./terminal-turn-decision";

const MAX_ARTIFACT_GATE_RETRIES = 4;
const MAX_REQUIRED_TOOL_GATE_RETRIES = 4;

/**
 * Applies a terminal (tool=none) policy decision. The executor does not own
 * these scenario gates; it delegates the whole terminal branch to this module.
 *
 * The input is a value object. Database reads needed by recovery have already
 * happened in IterationContext's FactsPort before this node runs.
 */
export async function handleToolNoneAction(input: {
  state: AgentGraphState;
  emit: (event: StepStreamEvent) => void;
  agentMode: AgentControlMode;
  processConfig: WorkflowProcessConfig | null;
  planSnapshot: unknown;
  availableTools: string[];
  summary: string | undefined;
}): Promise<Partial<AgentGraphState>> {
  const { state, emit, agentMode, processConfig, planSnapshot, availableTools } = input;
  const cleanedReason = stripToolCallSentinels(state.reasonText ?? "");
  const summary = input.summary?.trim() || cleanedReason.slice(0, 2000) || "no tool requested";

  const sharedSnapshotEarly = state.iterationContext?.snapshot ?? state.scenarioSnapshot ?? null;
  const controlDecision = decideTerminalControl({
    role: state.agentDefinition.role,
    agentMode,
    processConfig,
    planSnapshot,
    toolCalls: state.toolCalls,
    controlModeGapRetryCount: state.controlModeGapRetryCount,
    cleanedReason,
    // undefined：无场景快照时保持旧行为（仅 0 工具时拦 deferred）
    ...(sharedSnapshotEarly
      ? { researchFloorMet: sharedSnapshotEarly.researchArtifactsOk }
      : {}),
  });
  if (controlDecision.kind !== "allow") {
    emit({
      runId: state.runId,
      workflowId: state.workflowId,
      traceId: state.traceId,
      role: state.agentDefinition.role,
      type: "observe",
      stepIndex: state.iteration,
      ts: Date.now(),
      payload: controlDecision.observation,
    });
    if (controlDecision.kind === "continue") {
      return {
        observations: [...state.observations, controlDecision.observation],
        controlModeGapRetryCount: controlDecision.controlModeGapRetryCount,
      };
    }
    return {
      observations: [...state.observations, controlDecision.observation],
      finalResponse: {
        status: "terminated",
        reason: controlDecision.reason,
        error: controlDecision.error,
        answerText: controlDecision.answerText,
        iteration: state.iteration,
        role: state.agentDefinition.role,
      },
    };
  }

  /**
   * Scenario gate (Policy): act only applies decideToolNoneGate over the
   * shared per-iteration Snapshot — no scenario SQL / recovery orchestration here.
   */
  const sharedSnapshot = state.iterationContext?.snapshot ?? state.scenarioSnapshot ?? null;
  if (sharedSnapshot?.scenarioKey) {
    const scenarioKey = sharedSnapshot.scenarioKey;
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
    const requiredTools = getScenarioExpectation(scenarioKey).requiredTools;
    const { unavailableRequired, notAttempted } = assessRequiredToolGate({
      requiredTools,
      authorizedTools: sharedSnapshot.authorizedTools,
      attemptedTools: sharedSnapshot.attemptedTools,
      runnableTools: terminalManifest.tools,
      unavailableManifestTools: terminalManifest.unavailable,
      market: terminalManifest.market,
    });
    const decision = decideToolNoneGate({
      snapshot: {
        ...sharedSnapshot,
        notAttemptedCapabilities: notAttempted.map((gap) => gap.capability),
        unavailableCapabilities: unavailableRequired.map((gap) => gap.capability),
      },
      availableTools,
      goal: typeof terminalPayload.goal === "string" ? terminalPayload.goal : null,
      requiredToolRetryCount: state.requiredToolGapRetryCount ?? 0,
      artifactRetryCount: state.artifactGapRetryCount ?? 0,
      maxRequiredToolRetries: MAX_REQUIRED_TOOL_GATE_RETRIES,
      maxArtifactRetries: MAX_ARTIFACT_GATE_RETRIES,
      notAttempted,
      unavailableRequired,
      // Runtime should only enforce the minimum research floor.  Upgrade-grade
      // row counts and answer-schema checks remain visible in DeliveryVerdict,
      // but must not consume the loop on repeated recovery attempts.
      artifactOk: sharedSnapshot.researchArtifactsOk,
      artifactMissing: sharedSnapshot.missingArtifacts,
    });

    if (decision.kind === "push_back") {
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
          code: decision.code,
          scenario: scenarioKey,
          dataGaps: [...notAttempted, ...unavailableRequired],
          message: decision.message,
          suggestedTool: decision.recovery.nextTool,
          draftParams: decision.recovery.draftParams ?? {},
        },
      });
      return {
        observations: [
          ...state.observations,
          {
            level: "warn",
            code: decision.code,
            scenario: scenarioKey,
            dataGaps: [...notAttempted, ...unavailableRequired],
            hint: decision.message,
            suggestedTool: decision.recovery.nextTool,
            draftParams: decision.recovery.draftParams ?? {},
          },
        ],
        ...(decision.bumpRequiredToolRetry
          ? { requiredToolGapRetryCount: (state.requiredToolGapRetryCount ?? 0) + 1 }
          : {}),
        ...(decision.bumpArtifactRetry
          ? {
              artifactGapRetryCount: (state.artifactGapRetryCount ?? 0) + 1,
              noProgressRetryCount: 0,
            }
          : {}),
      };
    }

    if (decision.kind === "partial_stop") {
      const isArtifact = decision.code === "ARTIFACT_GATE_UNSATISFIED";
      const answerText = isArtifact
        ? [
            decision.message,
            "系统不会用空数据或模拟结果冒充成功。请恢复可用数据源后重试。",
            cleanedReason && cleanedReason !== "no tool requested"
              ? `当前可交付说明：\n${cleanedReason}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n")
        : decision.message;
      emit({
        runId: state.runId,
        workflowId: state.workflowId,
        traceId: state.traceId,
        role: state.agentDefinition.role,
        type: "observe",
        stepIndex: state.iteration,
        ts: Date.now(),
        payload: {
          level: isArtifact ? "error" : "warn",
          code: decision.code,
          scenario: scenarioKey,
          message: decision.message,
        },
      });
      return {
        observations: [
          ...state.observations,
          {
            level: isArtifact ? "error" : "warn",
            code: decision.code,
            scenario: scenarioKey,
            hint: decision.message,
          },
        ],
        finalResponse: {
          status: isArtifact ? "terminated" : "partial",
          reason: decision.reason,
          ...(isArtifact ? { error: decision.message } : {}),
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
      const db = await getDb();
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
        summary: input.summary,
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
