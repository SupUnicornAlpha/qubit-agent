import type { AgentControlMode, WorkflowProcessConfig } from "../../../types/loop";
import { assessGoalPlanCompletion, parseAgentPlanSnapshot } from "../../agent-control-mode";
import { assessWorkflowProcessGate } from "../../workflow/process-config";

/** Pure terminal control-plane decisions. No database, emit or clock access. */

export const MAX_CONTROL_MODE_GATE_RETRIES = 2;

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
}): TerminalDecision {
  if (input.role !== "orchestrator") return { kind: "allow" };

  const successfulBusinessToolCalls = input.toolCalls.filter(
    (call) =>
      call.status === "success" &&
      call.toolName !== "update_plan" &&
      call.toolName !== "tool/update_plan"
  ).length;

  if (input.agentMode !== "agent") {
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
