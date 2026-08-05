import type { AgentControlMode, WorkflowProcessConfig } from "../../../types/loop";
import { assessGoalPlanCompletion, parseAgentPlanSnapshot } from "../../agent-control-mode";
import { assessWorkflowProcessGate } from "../../workflow/process-config";
import { isLlmGatewayFailureText } from "../iteration-budget-policy";

/** Pure terminal control-plane decisions. No database, emit or clock access. */

export const MAX_CONTROL_MODE_GATE_RETRIES = 2;

/**
 * 识别「口述下一步动作、却没真正 tool=…」的假终局文案。
 *
 * 典型失败：模型写「先建计划，并立即并行补齐行情快照」然后不产 TOOL_CALL，
 * 运行时把文本当成 `tool=none` 直接 completed —— 用户感觉任务卡住/没做完。
 *
 * 无业务工具成功时始终生效；研究地板未满足时即使已有部分工具也会拦截口述收工。
 */
export function looksLikeDeferredToolIntent(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // 已写明结论/建议时，不当作「还要再干一轮」
  if (
    /(?:最终|综合)?(?:结论|建议|操作建议|投资建议|汇总如下|综上所述|给出建议)/.test(t) &&
    !/(?:稍后|即将|接下来会|将立即|并立即|马上拉取)/.test(t)
  ) {
    return false;
  }
  const deferred =
    /并立即|立即并行|并行补齐|先建计划|先创建|先执行|先落库|接下来(?:我会|我先|先|会)|即将(?:拉取|调用|获取|创建)|马上(?:拉取|获取|调用|补齐|创建)|将(?:拉取|调用|获取|补齐|创建)|我会(?:先|立即)|先(?:拉|取|查|补|创|建|跑|筛|注).{0,16}(?:再|然后|→|->)|按场景(?:合同|硬约束)|创建策略版本|生成纸面|筛候选\s*[→\->]|Step\s*1[：:].{0,20}创建|let me (?:fetch|pull|check|create)|i(?:'|’)ll (?:fetch|pull|check|create)|will now (?:fetch|call|create)/i;
  return deferred.test(t);
}

type TerminalDecision =
  | { kind: "allow" }
  | {
      kind: "continue";
      observation: Record<string, unknown>;
      controlModeGapRetryCount: number;
    }
  | {
      kind: "terminate";
      observation: Record<string, unknown>;
      reason: "control_mode_gate_unsatisfied" | "workflow_process_gate_unsatisfied";
      error: string;
      answerText: string;
    };

export function decideTerminalControl(input: {
  role: string;
  agentMode: AgentControlMode;
  processConfig: WorkflowProcessConfig | null;
  planSnapshot: unknown;
  toolCalls: Array<Record<string, unknown>>;
  controlModeGapRetryCount: number | undefined;
  cleanedReason: string;
  /**
   * 场景研究地板是否已满足。false 时：即使已有部分业务工具成功，
   * 「预告下一步却不调工具」仍强制再 reason（避免筛完就空转口述）。
   */
  researchFloorMet?: boolean;
}): TerminalDecision {
  if (input.role !== "orchestrator") return { kind: "allow" };

  const successfulBusinessToolCalls = input.toolCalls.filter(
    (call) =>
      call.status === "success" &&
      call.toolName !== "update_plan" &&
      call.toolName !== "tool/update_plan"
  ).length;
  const researchFloorMet = input.researchFloorMet !== false;

  // LLM 网关故障被当成 reasonText 时：禁止 tool=none 结案，强制再 reason
  if (isLlmGatewayFailureText(input.cleanedReason)) {
    const retryCount = input.controlModeGapRetryCount ?? 0;
    const message =
      "上一轮 LLM 网关失败（503/熔断/忙碌），没有合法结论或工具调用。" +
      "请重试本轮推理；若需工具请立刻发出 TOOL_CALL，不要用网关错误文案结束任务。";
    if (retryCount < MAX_CONTROL_MODE_GATE_RETRIES) {
      return {
        kind: "continue",
        controlModeGapRetryCount: retryCount + 1,
        observation: {
          level: "warn",
          controlModeGate: true,
          code: "LLM_GATEWAY_TRANSIENT",
          agentMode: input.agentMode,
          retryCount: retryCount + 1,
          maxRetries: MAX_CONTROL_MODE_GATE_RETRIES,
          message,
        },
      };
    }
    return {
      kind: "terminate",
      reason: "control_mode_gate_unsatisfied",
      error: message,
      observation: {
        level: "error",
        controlModeGate: true,
        code: "LLM_GATEWAY_EXHAUSTED",
        agentMode: input.agentMode,
        message,
      },
      answerText: [
        "模型通道暂时不可用，未能完成本轮任务。",
        input.cleanedReason ? `细节：${input.cleanedReason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  if (input.agentMode === "plan" || input.agentMode === "goal") {
    const parsedPlan = parseAgentPlanSnapshot(input.planSnapshot);
    const goalAssessment =
      input.agentMode === "goal"
        ? assessGoalPlanCompletion(input.planSnapshot)
        : {
            ok: Boolean(parsedPlan?.steps.length),
            message: "Plan 模式必须先调用 update_plan 保存可执行计划，再返回给用户。",
            pendingStepIds: [] as string[],
          };
    const hasExecutionEvidence = input.agentMode !== "goal" || successfulBusinessToolCalls > 0;
    if (!goalAssessment.ok || !hasExecutionEvidence) {
      const retryCount = input.controlModeGapRetryCount ?? 0;
      const message = !goalAssessment.ok
        ? goalAssessment.message
        : "Goal 模式尚无业务工具或专家执行成功的验证证据，不能仅更新计划后直接结束。";
      if (retryCount < MAX_CONTROL_MODE_GATE_RETRIES) {
        return {
          kind: "continue",
          controlModeGapRetryCount: retryCount + 1,
          observation: {
            level: "warn",
            controlModeGate: true,
            code:
              input.agentMode === "plan"
                ? "PLAN_REQUIRED"
                : hasExecutionEvidence
                  ? "GOAL_PLAN_INCOMPLETE"
                  : "GOAL_EVIDENCE_REQUIRED",
            agentMode: input.agentMode,
            pendingStepIds: goalAssessment.pendingStepIds,
            retryCount: retryCount + 1,
            maxRetries: MAX_CONTROL_MODE_GATE_RETRIES,
            message,
          },
        };
      }
      return {
        kind: "terminate",
        reason: "control_mode_gate_unsatisfied",
        error: message,
        observation: {
          level: "error",
          controlModeGate: true,
          code: "CONTROL_MODE_GATE_UNSATISFIED",
          agentMode: input.agentMode,
          message,
        },
        answerText: [
          `${input.agentMode === "plan" ? "计划生成" : "目标执行"}未通过完成门禁：${message}`,
          input.cleanedReason ? `当前说明：\n${input.cleanedReason}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    }
  }

  // agent 模式：「预告下一步却无 TOOL_CALL」→ 强制再 reason。
  // 研究地板未满足时，即使已有部分工具成功（如只跑完 screener）也不放行假终局。
  if (
    looksLikeDeferredToolIntent(input.cleanedReason) &&
    (successfulBusinessToolCalls === 0 || !researchFloorMet)
  ) {
    const retryCount = input.controlModeGapRetryCount ?? 0;
    const message =
      "你刚预告了下一步动作（拉数/并行工具/建计划后执行），但本轮没有发出合法 TOOL_CALL。" +
      "请立刻用 <TOOL_CALL> 调用具体工具（如 market.snapshot.get / assign_task / research.thesis.write）；不要用纯文字假装已开始执行。" +
      (!researchFloorMet && successfulBusinessToolCalls > 0
        ? "已有部分工具证据，但仍缺场景研究地板产物——请继续调用下一跳写工具，勿口述收工。"
        : "若已无需工具，请明确给出可交付结论/操作建议（不要再说“即将/立即/接下来会…”）。");
    if (retryCount < MAX_CONTROL_MODE_GATE_RETRIES) {
      return {
        kind: "continue",
        controlModeGapRetryCount: retryCount + 1,
        observation: {
          level: "warn",
          controlModeGate: true,
          code: "DEFERRED_TOOL_INTENT",
          agentMode: input.agentMode,
          retryCount: retryCount + 1,
          maxRetries: MAX_CONTROL_MODE_GATE_RETRIES,
          researchFloorMet,
          message,
        },
      };
    }
    // 重试耗尽后放行，避免死循环；交由上层标为 skippedToolCall / 场景闸收口
  }

  if (!input.processConfig) return { kind: "allow" };
  const processGate = assessWorkflowProcessGate({
    config: input.processConfig,
    plan: parseAgentPlanSnapshot(input.planSnapshot),
    successfulBusinessToolCalls,
  });
  if (processGate.ok) return { kind: "allow" };

  const retryCount = input.controlModeGapRetryCount ?? 0;
  const message = processGate.reasons.join(" ");
  if (retryCount < MAX_CONTROL_MODE_GATE_RETRIES) {
    return {
      kind: "continue",
      controlModeGapRetryCount: retryCount + 1,
      observation: {
        level: "warn",
        workflowProcessGate: true,
        code: "WORKFLOW_PROCESS_GATE_PENDING",
        retryCount: retryCount + 1,
        maxRetries: MAX_CONTROL_MODE_GATE_RETRIES,
        message,
      },
    };
  }
  return {
    kind: "terminate",
    reason: "workflow_process_gate_unsatisfied",
    error: message,
    observation: {
      level: "error",
      workflowProcessGate: true,
      code: "WORKFLOW_PROCESS_GATE_UNSATISFIED",
      message,
    },
    answerText: `流程完成门禁未通过：${message}`,
  };
}
