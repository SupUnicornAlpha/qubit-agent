/**
 * 为 Rust Core `turn.start.context` 补齐 host 侧上下文（WorkingMemory / focus）。
 * 与 reason 节点、Experience pipes 解耦，仅服务 Prime bridge。
 */
import { loadWorkingMemoryForTurn } from "../context/working-memory-loader";
import { toProtocolWorkingMemory } from "../context/working-memory-protocol";
import type { TurnContextOpts } from "./types";

export async function enrichTurnContextForCore(input: {
  workflowRunId: string;
  agentInstanceId?: string | null;
  base: TurnContextOpts;
}): Promise<TurnContextOpts> {
  const wm = await loadWorkingMemoryForTurn({
    workflowRunId: input.workflowRunId,
    agentInstanceId: input.agentInstanceId,
  });
  if (!wm) return input.base;

  const focusSymbols = wm.financeRefs?.symbols?.filter(Boolean) ?? [];
  return {
    ...input.base,
    working_memory: toProtocolWorkingMemory(wm),
    ...(focusSymbols.length > 0 ? { focus_symbols: focusSymbols } : {}),
  };
}
