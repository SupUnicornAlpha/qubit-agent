/**
 * TS ReAct residual inventory + hard guard for QUBIT_CORE_BACKEND=rust.
 *
 * Direct `executeAgentReact(` call sites (2026-08-05 audit):
 *   1. src/runtime/a2a/a2a-react-task.ts          — valved: rust → Core
 *   2. src/runtime/msa/role-reasoner.ts            — valved: rust → Core invoke
 *
 * Not ReAct (keep on Bun indefinitely / OUT of Core loop):
 *   - handlers/order-intent-handler.ts  (ORDER_INTENT sign/forward)
 *   - msa/* coordination (MSA fan-out, fusion) — orchestration glue
 *   - CLI role reasoners (claude_cli / codex_cli)
 *
 * Delete gate for executeAgentReact module:
 *   - soak rust default without QUBIT_ALLOW_TS_REACT_UNDER_RUST
 *   - no production traffic on ts backend
 *   - bridge covers required L2 tools for primary+subagent
 */

export type TsReactCallSite = {
  file: string;
  valve: "rust→core" | "ts-only";
  notes: string;
};

export const TS_REACT_CALL_SITES: readonly TsReactCallSite[] = [
  {
    file: "src/runtime/a2a/a2a-react-task.ts",
    valve: "rust→core",
    notes: "orchestrator→turn.start; specialist→agent.invoke",
  },
  {
    file: "src/runtime/msa/role-reasoner.ts",
    valve: "rust→core",
    notes: "NativeRoleReasoner → reasonSpecialistViaCore",
  },
] as const;

export const TS_REACT_OUT_OF_SCOPE = [
  "src/runtime/handlers/order-intent-handler.ts — ORDER_INTENT, no ReAct",
  "src/runtime/msa/analyst-team.ts — MSA wave/fusion glue",
  "src/runtime/msa/cli-role-reasoner.ts — external CLI engines",
] as const;

/** Escape hatch for soak / debugging when backend=rust must still run TS ReAct. */
export function isTsReactAllowedUnderRust(): boolean {
  return process.env.QUBIT_ALLOW_TS_REACT_UNDER_RUST === "1";
}

/**
 * Throw if rust backend would enter executeAgentReact without explicit allow.
 * Call at the top of executeAgentReact.
 */
export function assertTsReactAllowed(callerHint: string): void {
  const backend = (process.env.QUBIT_CORE_BACKEND ?? "ts").trim().toLowerCase();
  if (backend !== "rust") return;
  if (isTsReactAllowedUnderRust()) {
    console.warn(
      `[prime] TS ReAct entered under rust (QUBIT_ALLOW_TS_REACT_UNDER_RUST=1) via ${callerHint}`
    );
    return;
  }
  throw new Error(
    `TS ReAct blocked under QUBIT_CORE_BACKEND=rust (${callerHint}). Expected valve via Core turn/invoke. Set QUBIT_ALLOW_TS_REACT_UNDER_RUST=1 to override.`
  );
}
