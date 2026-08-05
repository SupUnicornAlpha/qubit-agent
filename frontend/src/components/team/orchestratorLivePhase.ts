/**
 * Orchestrator 右栏「还在跑」相位解析（纯函数，便于 bun:test）。
 */
import type { StepStreamEvent } from "../../api/types";
import type { SubAgentRunSummary } from "../../lib/subAgentRuns";
import { buildChatExecutionActivity } from "../chat/ChatExecutionActivity";

export type OrchestratorLivePhase =
  | { kind: "hitl"; label: string }
  | { kind: "tool"; label: string; detail: string }
  | { kind: "expert"; label: string; detail: string }
  | { kind: "thinking"; label: string; detail?: string }
  | { kind: "working"; label: string; detail?: string };

function formatRoleLabel(role: string): string {
  const trimmed = role.trim();
  if (!trimmed) return "专家";
  return trimmed.replace(/^analyst_/, "").replace(/_/g, " ");
}

export function resolveOrchestratorLivePhase(input: {
  running: boolean;
  chatInFlight: boolean;
  pendingHitl: boolean;
  activity: { tool: string; why: string } | null | undefined;
  streamEvents: StepStreamEvent[];
  subAgentRuns: SubAgentRunSummary[];
  thinkingText?: string | null;
}): OrchestratorLivePhase | null {
  if (input.pendingHitl) {
    return { kind: "hitl", label: "等待你确认" };
  }

  const activeExperts = input.subAgentRuns.filter(
    (run) => run.status === "running" || run.status === "queued"
  );
  const [firstExpert] = activeExperts;
  if (firstExpert) {
    return {
      kind: "expert",
      label:
        activeExperts.length > 1
          ? `${activeExperts.length} 位专家运行中`
          : `${formatRoleLabel(firstExpert.role)} 运行中`,
      detail: firstExpert.headline || "等待专家回传…",
    };
  }

  const activityModel = buildChatExecutionActivity(input.streamEvents, true);
  const runningTools = activityModel.tools.filter((tool) => tool.status === "running");
  const [firstTool] = runningTools;
  // 终态后未配对的 tool_call_start 不应继续撑着「调用中」动画
  if (firstTool && (input.running || input.chatInFlight)) {
    return {
      kind: "tool",
      label: runningTools.length > 1 ? `调用 ${runningTools.length} 个工具` : `调用 ${firstTool.name}`,
      detail: input.activity?.why?.trim() || firstTool.role,
    };
  }

  if (input.activity?.why && (input.running || input.chatInFlight)) {
    return {
      kind: "tool",
      label: input.activity.tool ? `调用 ${input.activity.tool}` : "执行中",
      detail: input.activity.why,
    };
  }

  // 残留流式文本在终态后仍可能留在 buffer；只有本轮仍在飞时才显示「思考中」
  const thinking = input.thinkingText?.trim();
  if (thinking && (input.running || input.chatInFlight)) {
    return {
      kind: "thinking",
      label: "思考中",
      detail: thinking.length > 80 ? `${thinking.slice(0, 80)}…` : thinking,
    };
  }

  if (input.running || input.chatInFlight) {
    return {
      kind: "working",
      label: input.chatInFlight ? "Orchestrator 处理中" : "工作流运行中",
      detail: "规划与派发中…",
    };
  }

  return null;
}
