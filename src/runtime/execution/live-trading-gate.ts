/**
 * Trading dispatch gates.
 *
 * - paper: local synthetic fills (no broker)
 * - sim:   real broker paper/sim environment (e.g. Futu TrdEnv.SIMULATE)
 * - live:  real broker production (requires QUBIT_LIVE_TRADING_ENABLED)
 */

export type DispatchMode = "paper" | "live" | "sim";
export type BrokerAccountMode = "mock" | "sandbox" | "live";

/** Global gate for real-money live broker dispatch (default off). */
export function isLiveTradingEnabled(): boolean {
  const v = process.env.QUBIT_LIVE_TRADING_ENABLED ?? "false";
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/**
 * Sim (券商模拟盘) gate — default ON so Futu sandbox can be used without
 * flipping the live kill-switch. Set QUBIT_SIM_TRADING_ENABLED=false to disable.
 */
export function isSimTradingEnabled(): boolean {
  const v = process.env.QUBIT_SIM_TRADING_ENABLED;
  if (v === undefined || v === "") return true;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function assertBrokerDispatchAllowed(
  dispatchMode: DispatchMode,
  accountMode: BrokerAccountMode,
  scope?: {
    provider?: BrokerProvider;
    accountRef?: string;
    projectId?: string;
    strategyId?: string;
  }
): void {
  if (dispatchMode === "paper") return;
  assertKillSwitchClear(scope);
  if (dispatchMode === "sim") {
    if (!isSimTradingEnabled()) throw new Error("sim_trading_disabled");
    if (accountMode === "live") {
      throw new Error("sim_dispatch_requires_sandbox_or_mock_broker_account");
    }
    return;
  }
  // live
  if (!isLiveTradingEnabled()) throw new Error("live_trading_disabled");
  if (accountMode !== "live") {
    throw new Error("live_dispatch_requires_live_broker_account");
  }
}

/** Normalize aliases: sandbox/simulate/paper_broker → sim */
export function parseDispatchMode(raw: unknown, fallback: DispatchMode = "paper"): DispatchMode {
  const v = String(raw ?? fallback)
    .trim()
    .toLowerCase();
  if (v === "paper" || v === "local") return "paper";
  if (v === "live" || v === "real") return "live";
  if (
    v === "sim" ||
    v === "simulate" ||
    v === "simulation" ||
    v === "sandbox" ||
    v === "paper_broker"
  ) {
    return "sim";
  }
  throw new Error(`invalid_dispatch_mode:${String(raw)}`);
}
import type { BrokerProvider } from "../../types/broker";
import { assertKillSwitchClear } from "./kill-switch";
