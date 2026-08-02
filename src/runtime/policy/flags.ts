/**
 * Feature flags for thin-loop / delivery verdict migration.
 *
 * - QUBIT_CONTRACT_AUTO_ADVANCE=hint|dispatch  (default: hint)
 * - QUBIT_DELIVERY_VERDICT_ENFORCE=0|1         (default: 1 — finalize uses verdict for salvage)
 * - QUBIT_THIN_LOOP=0|1                       (default: 1 — act skips business auto-dispatch)
 */

function env(name: string): string | undefined {
  return process.env[name]?.trim();
}

function isTruthy(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export type ContractAutoAdvanceMode = "hint" | "dispatch";

export function getContractAutoAdvanceMode(): ContractAutoAdvanceMode {
  const raw = (env("QUBIT_CONTRACT_AUTO_ADVANCE") ?? "hint").toLowerCase();
  return raw === "dispatch" ? "dispatch" : "hint";
}

/** When true (default), finalize salvage requires DeliveryVerdict.researchOk (soft floor). */
export function isDeliveryVerdictEnforceEnabled(): boolean {
  const raw = env("QUBIT_DELIVERY_VERDICT_ENFORCE");
  if (raw === undefined || raw === "") return true;
  return isTruthy(raw);
}

/** When true (default), act must not silently dispatch business write tools. */
export function isThinLoopEnabled(): boolean {
  const raw = env("QUBIT_THIN_LOOP");
  if (raw === undefined || raw === "") return true;
  return isTruthy(raw);
}

export function canDispatchBusinessAutoAdvance(toolName: string): boolean {
  if (!isThinLoopEnabled()) return true;
  if (getContractAutoAdvanceMode() !== "dispatch") return false;
  // Even in dispatch mode, only allow after explicit env (already checked).
  void toolName;
  return true;
}
