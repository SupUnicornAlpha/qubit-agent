/**
 * Generic loop budget policy.
 *
 * A hard iteration cap protects availability, but it is not a progress signal.
 * Stop earlier only after consecutive turns produced no new usable observation;
 * otherwise let a productive turn use the remaining token/time budget.
 */
import type { AgentGraphState } from "./state";

export const DEFAULT_MAX_CONSECUTIVE_UNPRODUCTIVE_TURNS = 4;
/** Soft recoveries allowed when research floor still unmet before hard-stopping. */
export const DEFAULT_MAX_UNPRODUCTIVE_RECOVERIES = 2;

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

/**
 * When the unproductive budget is hit but the scenario research floor is still
 * unmet, prefer one more nudged attempt over an immediate partial stop.
 */
export function shouldRecoverFromUnproductiveBudget(input: {
  researchFloorMet: boolean;
  notAttemptedCapabilities: readonly string[];
  missingArtifactTables: readonly string[];
  unproductiveRecoveryCount: number | undefined;
  maxUnproductiveRecoveries?: number;
}): boolean {
  if (input.researchFloorMet) return false;
  const max = input.maxUnproductiveRecoveries ?? DEFAULT_MAX_UNPRODUCTIVE_RECOVERIES;
  if ((input.unproductiveRecoveryCount ?? 0) >= max) return false;
  return (
    input.notAttemptedCapabilities.length > 0 || input.missingArtifactTables.length > 0
  );
}

/** LLM 网关故障文案：不应被当成「模型已决定 tool=none」结案。 */
export function isLlmGatewayFailureText(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    /^LLM gateway error:/i.test(text.trim()) ||
    /LLM gateway error\s*\[/i.test(text) ||
    /\bcode=(?:PROVIDER_BUSY|TRANSPORT|TIMEOUT|CIRCUIT_OPEN|RATE_LIMIT)\b/.test(text) ||
    /\bcircuit breaker open\b/i.test(text) ||
    /\b503\b.*(?:busy|unavailable)/i.test(text) ||
    /Service is too busy/i.test(text)
  );
}
