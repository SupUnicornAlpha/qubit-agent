/**
 * Generic loop budget policy.
 *
 * A hard iteration cap protects availability, but it is not a progress signal.
 * Stop earlier only after consecutive turns produced no new usable observation;
 * otherwise let a productive turn use the remaining token/time budget.
 */
import type { AgentGraphState } from "./state";

export const DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS = 3;

// Control-plane writes can be successful without producing task evidence. They
// must not reset the budget, otherwise an agent can evade it by repeatedly
// updating a plan.
const NON_EVIDENCE_TOOLS = new Set(["update_plan", "tool/update_plan"]);

export function didTurnMakeProgress(input: {
  beforeAct: Pick<AgentGraphState, "toolCalls" | "observations">;
  afterObserve: Pick<AgentGraphState, "toolCalls" | "observations">;
}): boolean {
  const newCalls = input.afterObserve.toolCalls.slice(input.beforeAct.toolCalls.length);
  return newCalls.some(
    (call) =>
      call.status === "success" && !NON_EVIDENCE_TOOLS.has(String(call.toolName))
  );
}

export function nextUnproductiveTurnCount(input: {
  previous: number | undefined;
  madeProgress: boolean;
}): number {
  return input.madeProgress ? 0 : (input.previous ?? 0) + 1;
}

export function shouldStopForUnproductiveTurns(input: {
  consecutiveUnproductiveTurns: number;
  maxConsecutiveUnproductiveTurns?: number;
}): boolean {
  const max = input.maxConsecutiveUnproductiveTurns ?? DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS;
  return input.consecutiveUnproductiveTurns >= max;
}
