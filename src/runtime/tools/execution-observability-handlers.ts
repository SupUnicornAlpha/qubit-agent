import type { BrokerProvider } from "../../types/broker";
import {
  brokerGetBalances,
  brokerGetCapabilities,
  brokerGetFills,
  brokerGetMargin,
  brokerGetOpenOrders,
  brokerGetOrder,
  brokerGetPositions,
} from "../execution/broker/broker-service";
import { engagedKillSwitches } from "../execution/kill-switch";
import { scanPositionReconciliation } from "../execution/position-reconciliation-service";
import { getTradingModuleStatus } from "../trader/trading-module-control";
import type { BuiltinToolHandler } from "./types";

const PROVIDERS = new Set<BrokerProvider>([
  "futu",
  "ib",
  "ccxt",
  "alpaca",
  "supermind",
  "eastmoney_emt",
  "qmt",
]);

function providerFrom(params: Record<string, unknown>): BrokerProvider {
  const provider = String(params.provider ?? "").trim() as BrokerProvider;
  if (!PROVIDERS.has(provider)) {
    throw new Error("provider must be one of futu, ib, ccxt, alpaca, supermind, eastmoney_emt, qmt");
  }
  return provider;
}

function accountRefFrom(params: Record<string, unknown>): string | undefined {
  const accountRef = String(params.accountRef ?? params.account_ref ?? "").trim();
  return accountRef || undefined;
}

/**
 * Read-only execution operations. They intentionally never submit, cancel, or
 * modify an order, so they are safe for the default execution monitor Agent.
 */
export const EXECUTION_OBSERVABILITY_HANDLERS: Record<string, BuiltinToolHandler> = {
  "execution.account.snapshot": async (_ctx, params) => {
    const provider = providerFrom(params);
    const accountRef = accountRefFrom(params);
    const capabilities = await brokerGetCapabilities({
      provider,
      ...(accountRef ? { accountRef } : {}),
    });
    const positions = await brokerGetPositions({ provider, ...(accountRef ? { accountRef } : {}) });
    const balances = capabilities.balances
      ? await brokerGetBalances({ provider, ...(accountRef ? { accountRef } : {}) })
      : null;
    const margin = capabilities.margin
      ? await brokerGetMargin({ provider, ...(accountRef ? { accountRef } : {}) })
      : null;
    return {
      provider,
      accountRef: accountRef ?? null,
      asOf: new Date().toISOString(),
      capabilities,
      positions,
      balances,
      margin,
    };
  },

  "execution.order.get": async (_ctx, params) => {
    const provider = providerFrom(params);
    const accountRef = accountRefFrom(params);
    const brokerOrderId = String(params.brokerOrderId ?? params.broker_order_id ?? "").trim();
    if (!brokerOrderId) throw new Error("brokerOrderId is required");
    const input = { provider, ...(accountRef ? { accountRef } : {}), brokerOrderId };
    const [order, fills] = await Promise.all([brokerGetOrder(input), brokerGetFills(input)]);
    return { provider, accountRef: accountRef ?? null, order, fills };
  },

  "order.list_open": async (_ctx, params) => {
    const provider = providerFrom(params);
    const accountRef = accountRefFrom(params);
    return {
      provider,
      accountRef: accountRef ?? null,
      orders: await brokerGetOpenOrders({ provider, ...(accountRef ? { accountRef } : {}) }),
    };
  },

  "provider.capabilities": async (_ctx, params) => {
    const provider = providerFrom(params);
    const accountRef = accountRefFrom(params);
    return {
      provider,
      accountRef: accountRef ?? null,
      capabilities: await brokerGetCapabilities({
        provider,
        ...(accountRef ? { accountRef } : {}),
      }),
    };
  },

  "execution.reconcile.positions": async (ctx, params) => {
    const provider = providerFrom(params);
    const accountRef = accountRefFrom(params);
    const projectId = String(params.projectId ?? params.project_id ?? ctx.projectId ?? "").trim();
    if (!projectId) throw new Error("projectId is required");
    return scanPositionReconciliation({
      projectId,
      provider,
      ...(accountRef ? { accountRef } : {}),
    });
  },

  "execution.kill_switch.status": async (_ctx, params) => {
    const providerRaw = String(params.provider ?? "").trim();
    const provider = providerRaw ? providerFrom(params) : undefined;
    const accountRef = accountRefFrom(params);
    const projectId = String(params.projectId ?? params.project_id ?? "").trim() || undefined;
    const strategyId = String(params.strategyId ?? params.strategy_id ?? "").trim() || undefined;
    const engaged = engagedKillSwitches({
      ...(provider ? { provider } : {}),
      ...(accountRef ? { accountRef } : {}),
      ...(projectId ? { projectId } : {}),
      ...(strategyId ? { strategyId } : {}),
    });
    const module = await getTradingModuleStatus();
    if (!module.enabled) engaged.push("trading_module");
    return {
      clear: engaged.length === 0,
      engaged,
      tradingModule: module,
      scope: {
        provider: provider ?? null,
        accountRef: accountRef ?? null,
        projectId: projectId ?? null,
        strategyId: strategyId ?? null,
      },
    };
  },
};
