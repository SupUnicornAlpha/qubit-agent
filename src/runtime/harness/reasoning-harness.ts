/**
 * Qubit Reasoning Harness is the product-owned, provider-neutral guardrail
 * layer around model reasoning. It must never be named after a model vendor:
 * providers can propose claims, while Qubit owns their contracts, verification
 * and audit trail.
 */
export const QUBIT_REASONING_HARNESS = {
  id: "qubit.reasoning-harness",
  title: "Qubit Reasoning Harness",
  version: "1.0.0",
} as const;

export type ReasoningHarnessMode = "off" | "advisory" | "required";

/**
 * Explicit, deterministic activation input. Callers must classify intent from
 * workflow metadata/UI; arbitrary conversation text is deliberately not used
 * to turn on expensive or blocking verification.
 */
export type ReasoningHarnessActivationInput = {
  capabilityEnabled: boolean;
  requestedMode?: ReasoningHarnessMode;
  workflowKind?: string | null;
  hasMathematicalClaim?: boolean;
  affectsDecision?: boolean;
};

const HIGH_ASSURANCE_WORKFLOWS = new Set([
  "strategy",
  "factor",
  "backtest",
  "risk",
  "options",
  "portfolio",
  "live_trading",
]);

/**
 * Resolves the smallest useful scope. A disabled profile is always inert; a
 * formula appearing in an ordinary conversation never activates the Harness.
 */
export function resolveReasoningHarnessMode(
  input: ReasoningHarnessActivationInput
): ReasoningHarnessMode {
  if (!input.capabilityEnabled) return "off";
  if (input.requestedMode === "off") return "off";
  if (input.requestedMode === "required") return "required";
  if (input.requestedMode === "advisory") return "advisory";
  const workflow = input.workflowKind?.trim().toLowerCase() ?? "";
  if (
    input.hasMathematicalClaim === true &&
    input.affectsDecision === true &&
    HIGH_ASSURANCE_WORKFLOWS.has(workflow)
  ) {
    return "required";
  }
  return "off";
}
