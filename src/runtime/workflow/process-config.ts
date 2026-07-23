import {
  type AgentControlMode,
  type WorkflowProcessConfig,
  WorkflowProcessConfigSchema,
} from "../../types/loop";
import type { AgentPlanSnapshot } from "../agent-control-mode";

export function normalizeWorkflowProcessConfig(raw: unknown): WorkflowProcessConfig | null {
  const parsed = WorkflowProcessConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Plan mode is intentionally non-executing, so an evidence/tool-call gate would be impossible to
 * satisfy. Keep the persisted workflow policy intact and only disable that gate for this turn.
 */
export function resolveEffectiveWorkflowProcessConfig(
  config: WorkflowProcessConfig | null,
  agentMode: AgentControlMode
): WorkflowProcessConfig | null {
  if (!config || agentMode !== "plan" || !config.gates.requireEvidence) return config;
  return {
    ...config,
    gates: {
      ...config.gates,
      requireEvidence: false,
    },
  };
}

export function buildWorkflowProcessPrompt(config: WorkflowProcessConfig | null): string {
  if (!config) return "";
  const steps = config.sopSteps.filter((step) => step.title.trim());
  const gates = config.gates;
  if (steps.length === 0 && !gates.requirePlanCompleted && !gates.requireEvidence) return "";
  return [
    "## Workflow 流程配置",
    config.templateId ? `- 模板：${config.templateId}` : "",
    config.sopPreset ? `- SOP 预设：${config.sopPreset}` : "",
    steps.length > 0
      ? [
          "- SOP（按顺序推进；required=true 的步骤不得静默跳过）：",
          ...steps.map(
            (step, index) =>
              `  ${index + 1}. [${step.required === false ? "可选" : "必需"}] ${step.title}`
          ),
        ].join("\n")
      : "",
    gates.requirePlanCompleted ? "- 完成门控：计划必须全部闭环。" : "",
    gates.requireEvidence
      ? `- 完成门控：至少 ${gates.minSuccessfulToolCalls} 次真实业务工具或专家调用成功，才能结束。`
      : "",
    "- Workflow 配置只约束执行过程；用户消息与最终答复仍写入统一会话。",
  ]
    .filter(Boolean)
    .join("\n");
}

export function assessWorkflowProcessGate(input: {
  config: WorkflowProcessConfig | null;
  plan: AgentPlanSnapshot | null;
  successfulBusinessToolCalls: number;
}): { ok: boolean; reasons: string[] } {
  const gates = input.config?.gates;
  if (!gates) return { ok: true, reasons: [] };
  const reasons: string[] = [];
  if (gates.requirePlanCompleted) {
    if (!input.plan || input.plan.steps.length === 0) {
      reasons.push("流程门控要求先建立计划。");
    } else {
      const pending = input.plan.steps.filter(
        (step) => step.status === "pending" || step.status === "in_progress"
      );
      if (pending.length > 0) reasons.push(`流程计划仍有 ${pending.length} 个步骤未闭环。`);
    }
  }
  if (gates.requireEvidence && input.successfulBusinessToolCalls < gates.minSuccessfulToolCalls) {
    reasons.push(
      `流程门控要求至少 ${gates.minSuccessfulToolCalls} 次真实业务工具或专家调用成功；当前 ${input.successfulBusinessToolCalls} 次。`
    );
  }
  return { ok: reasons.length === 0, reasons };
}
