/**
 * Phase B: TS Agent runtime removed. Inventory kept for migration notes.
 *
 * Former `executeAgentReact` call sites have been reduced to Core adapters:
 *   1. src/runtime/a2a/a2a-react-task.ts → runOrchestratorTaskViaCore / reasonSpecialistViaCore
 *
 * Host (Bun) retains external capabilities under `src/runtime/host/`:
 *   - event-stream / step-stream types
 *   - checkpoint row load/delete
 *   - tool-error-classifier
 *
 * Topology UI projection lives in `host/team-workflow-graph.ts` (not an Agent loop).
 */

export type TsReactCallSite = {
  file: string;
  valve: "rust→core";
  notes: string;
};

export const TS_REACT_CALL_SITES: readonly TsReactCallSite[] = [
  {
    file: "src/runtime/a2a/a2a-react-task.ts",
    valve: "rust→core",
    notes: "Host-side A2A adapter delegates every Agent turn/invoke to Core",
  },
] as const;

export const TS_REACT_OUT_OF_SCOPE = [
  "src/runtime/host/* — Bun Host observability / cleanup (not a Core)",
  "src/runtime/host/team-workflow-graph.ts — Team UI topology projection",
  "src/runtime/handlers/order-intent-handler.ts — ORDER_INTENT, no loop",
] as const;

/** @deprecated Always false after Phase A/B. */
export function isTsReactAllowedUnderRust(): boolean {
  return false;
}

/**
 * Any attempt to enter a TS Agent loop is a hard error.
 * Prefer Core turn/invoke; there is no TS runtime anymore.
 */
export function assertTsReactAllowed(callerHint: string): void {
  throw new Error(
    `TS Agent runtime removed (Phase B). Refusing entry via ${callerHint}. ` +
      `Use QUBIT_CORE_BACKEND=rust + Core turn/invoke.`
  );
}
