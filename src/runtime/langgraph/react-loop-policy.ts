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

/**
 * 本轮 observe 后是否应结束循环。
 *
 * 触发条件（任一即停）：
 * 1. 最近一次 observation 标记了 `skippedToolCall`：即 LLM 明确输出
 *    `tool:"none"`，文字结论已就绪，不应再走 reason→act 重跑。
 * 2. `finalResponse` 已被 act / hitl_gate 写入终态（兜底，正常 execute-agent-react
 *    的条件边也会 finalize，这里再次保险）。
 *
 * 注意：旧实现额外要求 `plannedAction !== "tool_call"`，但 reason 节点会在
 * `hasTools=true` 时无条件写 `plannedAction="tool_call"`，导致条件永不成立，
 * ReAct 死循环。该字段仅反映 reason 阶段的预测，不该用来判断 observe 后是否
 * 应该收敛，已移除。
 */
export function shouldStopReactLoopAfterObserve(state: AgentGraphState): boolean {
  if (state.finalResponse) return true;
  const last = state.observations.at(-1) as { skippedToolCall?: boolean } | undefined;
  if (last?.skippedToolCall) return true;
  return false;
}
