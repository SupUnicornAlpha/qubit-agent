import type { LoopOptionsJson } from "../../types/loop";
import type { RuntimeAgentDefinition } from "../types";
import type { AgentGraphState } from "./state";

/**
 * 是否在 observe 后继续回到 reason（多轮 ReAct）。
 * Native / A2A Agent 内建循环即为 perceive→reason→act→observe；
 * 默认在 maxIterations>1 时允许多轮，仅任务/工作流显式关闭时禁用。
 */
export function resolveForceReactLoop(input: {
  def: RuntimeAgentDefinition;
  payloadParams?: Record<string, unknown>;
  loopOptions?: LoopOptionsJson;
}): boolean {
  const p = input.payloadParams ?? {};
  if (p["forceLoop"] === true) return true;
  if (p["forceLoop"] === false) return false;
  if (input.loopOptions?.reactLoop === true) return true;
  if (input.loopOptions?.reactLoop === false) return false;
  return input.def.maxIterations > 1;
}

/** 本轮 observe 后是否应结束循环（模型未请求工具且已有文字结论） */
export function shouldStopReactLoopAfterObserve(state: AgentGraphState): boolean {
  const last = state.observations.at(-1) as { skippedToolCall?: boolean } | undefined;
  if (last?.skippedToolCall && state.plannedAction !== "tool_call") {
    return true;
  }
  return false;
}
