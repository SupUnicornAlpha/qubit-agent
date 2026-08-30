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

export type ReasoningHarnessTaskMetadata = Record<string, unknown>;

const HIGH_ASSURANCE_WORKFLOWS = new Set([
  "strategy",
  "factor",
  "backtest",
  "risk",
  "options",
  "portfolio",
  "live_trading",
]);

function normalizeWorkflowKind(value: string | null | undefined): string {
  const workflow =
    value
      ?.trim()
      .toLowerCase()
      .replace(/[-\s]+/g, "_") ?? "";
  for (const kind of HIGH_ASSURANCE_WORKFLOWS) {
    if (workflow === kind || workflow.startsWith(`${kind}_`)) return kind;
  }
  return workflow;
}

function readMode(value: unknown): ReasoningHarnessMode | undefined {
  return value === "off" || value === "advisory" || value === "required" ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function firstString(metadata: ReasoningHarnessTaskMetadata, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

/**
 * Adapt UI/workflow metadata without inspecting arbitrary user prose. Both
 * prompt assembly and tool execution use this function, so a tool cannot be
 * silently enabled in one layer while the other remains inert.
 */
export function resolveReasoningHarnessModeFromTaskMetadata(input: {
  capabilityEnabled: boolean;
  metadata?: ReasoningHarnessTaskMetadata | null;
  requestedMode?: unknown;
}): ReasoningHarnessMode {
  const metadata = input.metadata ?? {};
  const requestedMode =
    readMode(input.requestedMode) ?? readMode(metadata.mathMode) ?? readMode(metadata.math_mode);
  const workflowKind = firstString(metadata, [
    "workflowKind",
    "workflow_kind",
    "taskType",
    "task_type",
    "scenarioKey",
    "scenario_key",
  ]);
  return resolveReasoningHarnessMode({
    capabilityEnabled: input.capabilityEnabled,
    ...(requestedMode ? { requestedMode } : {}),
    ...(workflowKind ? { workflowKind } : {}),
    hasMathematicalClaim:
      readBoolean(metadata.hasMathematicalClaim) || readBoolean(metadata.has_mathematical_claim),
    affectsDecision:
      readBoolean(metadata.affectsDecision) || readBoolean(metadata.affects_decision),
  });
}

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
  const workflow = normalizeWorkflowKind(input.workflowKind);
  if (
    input.hasMathematicalClaim === true &&
    input.affectsDecision === true &&
    HIGH_ASSURANCE_WORKFLOWS.has(workflow)
  ) {
    return "required";
  }
  return "off";
}
