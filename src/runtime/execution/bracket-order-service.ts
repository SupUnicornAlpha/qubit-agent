import { randomUUID } from "node:crypto";
import type { DbClient } from "../../db/sqlite/client";
import { runInTransaction } from "../../db/sqlite/client";
import type { OrderSide, TimeInForce } from "../../types/entities";
import {
  createOrderIntentWithExecution,
  type CreateOrderIntentResult,
  type DispatchMode,
} from "./order-intent-service";

export interface CreateBracketOrderInput {
  workflowRunId: string;
  strategyVersionId: string;
  instrumentId: string;
  side: OrderSide;
  qty: number;
  entryOrderType: "market" | "limit";
  entryReferencePrice: number;
  entryLimitPrice?: number | null;
  takeProfitPrice: number;
  stopLossPrice: number;
  timeInForce: TimeInForce;
  accountId?: string;
  dispatchMode?: DispatchMode;
  brokerAccountId?: string | null;
  market?: string | null;
  symbol?: string | null;
  clientOrderId?: string | null;
}

export interface CreateBracketOrderResult {
  bracketId: string;
  ocoGroupId: string;
  entry: CreateOrderIntentResult;
  takeProfit: CreateOrderIntentResult;
  stopLoss: CreateOrderIntentResult;
}

function validateBracket(input: CreateBracketOrderInput): void {
  const prices = [input.entryReferencePrice, input.takeProfitPrice, input.stopLossPrice];
  if (prices.some((price) => !Number.isFinite(price) || price <= 0)) {
    throw new Error("bracket_prices_must_be_positive");
  }
  if (!Number.isFinite(input.qty) || input.qty <= 0) throw new Error("bracket_quantity_must_be_positive");
  if (input.entryOrderType === "limit" && (!input.entryLimitPrice || input.entryLimitPrice <= 0)) {
    throw new Error("bracket_limit_entry_requires_price");
  }
  if (input.side === "buy") {
    if (!(input.stopLossPrice < input.entryReferencePrice && input.entryReferencePrice < input.takeProfitPrice)) {
      throw new Error("long_bracket_requires_stop_below_entry_and_target_above_entry");
    }
  } else if (!(input.takeProfitPrice < input.entryReferencePrice && input.entryReferencePrice < input.stopLossPrice)) {
    throw new Error("short_bracket_requires_target_below_entry_and_stop_above_entry");
  }
}

export async function createBracketOrder(
  db: DbClient,
  input: CreateBracketOrderInput,
): Promise<CreateBracketOrderResult> {
  validateBracket(input);
  const bracketId = randomUUID();
  const ocoGroupId = `bracket:${bracketId}`;
  const childSide: OrderSide = input.side === "buy" ? "sell" : "buy";
  const baseClientOrderId = input.clientOrderId?.trim() || `bracket:${bracketId}`;

  return runInTransaction(db, async () => {
    const common = {
      workflowRunId: input.workflowRunId,
      strategyVersionId: input.strategyVersionId,
      instrumentId: input.instrumentId,
      qty: input.qty,
      timeInForce: input.timeInForce,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.dispatchMode ? { dispatchMode: input.dispatchMode } : {}),
      ...(input.brokerAccountId ? { brokerAccountId: input.brokerAccountId } : {}),
      ...(input.market ? { market: input.market } : {}),
      ...(input.symbol ? { symbol: input.symbol } : {}),
    } as const;
    const entry = await createOrderIntentWithExecution(db, {
      ...common,
      side: input.side,
      orderType: input.entryOrderType,
      price: input.entryOrderType === "limit"
        ? input.entryLimitPrice ?? input.entryReferencePrice
        : input.entryReferencePrice,
      clientOrderId: `${baseClientOrderId}:entry`,
    });
    if (entry.riskOutcome === "block") throw new Error(`bracket_entry_risk_blocked:${entry.riskReason}`);

    const takeProfit = await createOrderIntentWithExecution(db, {
      ...common,
      side: childSide,
      orderType: "stop_limit",
      price: input.takeProfitPrice,
      stopPrice: input.takeProfitPrice,
      triggerDirection: input.side === "buy" ? "above" : "below",
      parentOrderIntentId: entry.orderIntentId,
      ocoGroupId,
      clientOrderId: `${baseClientOrderId}:take-profit`,
    });
    if (takeProfit.riskOutcome === "block") {
      throw new Error(`bracket_take_profit_risk_blocked:${takeProfit.riskReason}`);
    }

    const stopLoss = await createOrderIntentWithExecution(db, {
      ...common,
      side: childSide,
      orderType: "stop",
      price: input.stopLossPrice,
      stopPrice: input.stopLossPrice,
      triggerDirection: input.side === "buy" ? "below" : "above",
      parentOrderIntentId: entry.orderIntentId,
      ocoGroupId,
      clientOrderId: `${baseClientOrderId}:stop-loss`,
    });
    if (stopLoss.riskOutcome === "block") {
      throw new Error(`bracket_stop_loss_risk_blocked:${stopLoss.riskReason}`);
    }

    return { bracketId, ocoGroupId, entry, takeProfit, stopLoss };
  });
}
