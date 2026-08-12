import type { BrokerProvider } from "../../types/broker";

/**
 * Fail-closed layered dispatch stop controls. Values are intentionally process
 * configuration: an operator can stop flows even when SQLite is unhealthy.
 *
 * QUBIT_KILL_SWITCH=1                          all broker dispatch
 * QUBIT_KILL_SWITCH_PROVIDERS=ccxt,ib          venue level
 * QUBIT_KILL_SWITCH_ACCOUNTS=ib:DU123,ACC-2    account level
 * QUBIT_KILL_SWITCH_PROJECTS=project-a          tenant/project level
 * QUBIT_KILL_SWITCH_STRATEGIES=strategy-a       strategy level
 */
export type KillSwitchScope = {
  provider?: BrokerProvider;
  accountRef?: string;
  projectId?: string;
  strategyId?: string;
};

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

function values(key: string): Set<string> {
  return new Set(
    (process.env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

export function engagedKillSwitches(scope: KillSwitchScope = {}): string[] {
  const engaged: string[] = [];
  if (enabled(process.env.QUBIT_KILL_SWITCH)) engaged.push("global");
  if (scope.provider && values("QUBIT_KILL_SWITCH_PROVIDERS").has(scope.provider)) {
    engaged.push(`provider:${scope.provider}`);
  }
  if (scope.accountRef) {
    const accountValues = values("QUBIT_KILL_SWITCH_ACCOUNTS");
    if (
      accountValues.has(scope.accountRef) ||
      (scope.provider !== undefined && accountValues.has(`${scope.provider}:${scope.accountRef}`))
    ) {
      engaged.push(`account:${scope.provider ?? "*"}:${scope.accountRef}`);
    }
  }
  if (scope.projectId && values("QUBIT_KILL_SWITCH_PROJECTS").has(scope.projectId)) {
    engaged.push(`project:${scope.projectId}`);
  }
  if (scope.strategyId && values("QUBIT_KILL_SWITCH_STRATEGIES").has(scope.strategyId)) {
    engaged.push(`strategy:${scope.strategyId}`);
  }
  return engaged;
}

export function assertKillSwitchClear(scope: KillSwitchScope = {}): void {
  const engaged = engagedKillSwitches(scope);
  if (engaged.length > 0) throw new Error(`kill_switch_engaged:${engaged.join(",")}`);
}
