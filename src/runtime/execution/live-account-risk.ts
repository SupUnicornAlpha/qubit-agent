import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { instrument, strategyRuntime } from "../../db/sqlite/schema";
import type { BrokerBalance, BrokerConnector, BrokerPosition } from "../reia/broker-connector";
import type { LiveAccountRiskLimits } from "./live-runtime-guardrails";
import { assertLiveRuntimeAccountRiskLimits } from "./live-runtime-guardrails";
import { computeNotionalUsd, readContractMultiplier } from "./pre-trade-risk";

export type LiveAccountRiskDecision =
  | { ok: true; grossNotionalUsd: number; symbolNotionalUsd: number; openPositions: number }
  | { ok: false; reason: string };

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function symbolKey(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * The broker snapshot is intentionally narrow and no-I/O. Acquisition stays
 * in the broker adapter, which keeps this risk policy easy to test, load and
 * remove without changing connector registration.
 */
export function assessLiveAccountRisk(input: {
  limits: LiveAccountRiskLimits;
  balances: BrokerBalance[];
  positions: BrokerPosition[];
  side: "buy" | "sell";
  symbol: string;
  orderNotionalUsd: number;
}): LiveAccountRiskDecision {
  if (!finitePositive(input.orderNotionalUsd)) {
    return { ok: false, reason: "live_account_risk_order_notional_invalid" };
  }
  const balance = input.balances.find((item) => item.currency.trim().toUpperCase() === "USD");
  if (!balance || !Number.isFinite(balance.cash)) {
    return { ok: false, reason: "live_account_risk_usd_balance_missing" };
  }
  const available = balance.available;
  if (typeof available !== "number" || !Number.isFinite(available)) {
    return { ok: false, reason: "live_account_risk_available_cash_missing" };
  }

  const positions = new Map<string, { signedNotional: number; grossNotional: number }>();
  for (const position of input.positions) {
    if (!position.symbol.trim() || !Number.isFinite(position.qty)) {
      return { ok: false, reason: "live_account_risk_position_invalid" };
    }
    if (position.qty === 0) continue;
    const mark = finitePositive(position.lastPrice)
      ? position.lastPrice
      : typeof position.marketValue === "number" && Number.isFinite(position.marketValue)
        ? Math.abs(position.marketValue / position.qty)
        : undefined;
    if (!finitePositive(mark)) {
      return {
        ok: false,
        reason: `live_account_risk_position_mark_missing:${symbolKey(position.symbol)}`,
      };
    }
    const signedNotional = position.qty * mark;
    const key = symbolKey(position.symbol);
    const previous = positions.get(key) ?? { signedNotional: 0, grossNotional: 0 };
    positions.set(key, {
      signedNotional: previous.signedNotional + signedNotional,
      grossNotional: previous.grossNotional + Math.abs(signedNotional),
    });
  }

  const key = symbolKey(input.symbol);
  const current = positions.get(key)?.signedNotional ?? 0;
  const signedOrder = input.side === "buy" ? input.orderNotionalUsd : -input.orderNotionalUsd;
  const projectedSymbol = Math.abs(current + signedOrder);
  const grossBefore = [...positions.values()].reduce(
    (sum, position) => sum + position.grossNotional,
    0
  );
  const projectedGross = grossBefore - Math.abs(current) + projectedSymbol;
  const openBefore = [...positions.values()].filter(
    (position) => position.signedNotional !== 0
  ).length;
  const openAfter = openBefore + (current === 0 && projectedSymbol > 0 ? 1 : 0);
  const projectedAvailable = input.side === "buy" ? available - input.orderNotionalUsd : available;

  if (projectedAvailable < input.limits.minAvailableCashUsd) {
    return { ok: false, reason: "live_account_risk_min_available_cash_breached" };
  }
  if (projectedSymbol > input.limits.maxSymbolNotionalUsd) {
    return { ok: false, reason: "live_account_risk_symbol_notional_exceeded" };
  }
  if (projectedGross > input.limits.maxGrossNotionalUsd) {
    return { ok: false, reason: "live_account_risk_gross_notional_exceeded" };
  }
  if (openAfter > input.limits.maxOpenPositions) {
    return { ok: false, reason: "live_account_risk_open_position_count_exceeded" };
  }
  return {
    ok: true,
    grossNotionalUsd: projectedGross,
    symbolNotionalUsd: projectedSymbol,
    openPositions: openAfter,
  };
}

/**
 * Fetches the authoritative account state immediately before the broker call.
 * It intentionally has no database cache: a stale balance/position snapshot is
 * worse than a rejected live order. The connector boundary makes the I/O
 * replaceable while retaining one fail-closed policy implementation.
 */
export async function assertLiveBrokerAccountRiskFresh(input: {
  db: DbClient;
  intent: {
    strategyRuntimeId: string | null;
    instrumentId: string;
    symbol: string | null;
    side: "buy" | "sell";
    qty: number;
    price: number | null;
  };
  connector: BrokerConnector;
}): Promise<Extract<LiveAccountRiskDecision, { ok: true }>> {
  const runtimeId = input.intent.strategyRuntimeId?.trim();
  if (!runtimeId) throw new Error("live_execution_requires_strategy_runtime");
  const runtime = (
    await input.db
      .select({ paramsJson: strategyRuntime.paramsJson })
      .from(strategyRuntime)
      .where(eq(strategyRuntime.id, runtimeId))
      .limit(1)
  )[0];
  if (!runtime) throw new Error("strategy_runtime_not_found");
  const params =
    runtime.paramsJson &&
    typeof runtime.paramsJson === "object" &&
    !Array.isArray(runtime.paramsJson)
      ? (runtime.paramsJson as Record<string, unknown>)
      : {};
  const limits = assertLiveRuntimeAccountRiskLimits(params.liveGuardrails);
  if (!input.connector.getBalances) {
    throw new Error("live_account_risk_balances_capability_missing");
  }
  const instruments = await input.db
    .select({ symbol: instrument.symbol, metaJson: instrument.metaJson })
    .from(instrument)
    .where(eq(instrument.id, input.intent.instrumentId))
    .limit(1);
  const inst = instruments[0];
  if (!inst) throw new Error("instrument_not_found");
  const orderNotionalUsd = computeNotionalUsd(
    input.intent.qty,
    input.intent.price,
    readContractMultiplier(inst.metaJson)
  );
  if (orderNotionalUsd === null) {
    throw new Error("live_account_risk_order_notional_invalid");
  }
  let balances: BrokerBalance[];
  let positions: BrokerPosition[];
  try {
    [balances, positions] = await Promise.all([
      input.connector.getBalances(),
      input.connector.getPositions(),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`live_account_risk_snapshot_unavailable:${detail}`);
  }
  const decision = assessLiveAccountRisk({
    limits,
    balances,
    positions,
    side: input.intent.side,
    symbol: input.intent.symbol ?? inst.symbol,
    orderNotionalUsd,
  });
  if (!decision.ok) throw new Error(decision.reason);
  return decision;
}
