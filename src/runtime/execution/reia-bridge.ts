import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import {
  instrument,
  intentOrder,
  strategy,
  strategyVersion,
  workflowRun,
} from "../../db/sqlite/schema";
import type { BrokerProvider } from "../../types/broker";
import { createOrderIntentWithExecution, type CreateOrderIntentResult } from "./order-intent-service";

export interface ReiaOrderPayload {
  workflowRunId: string;
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  market?: string;
  timeframe?: string;
  executionMode?: "paper" | "live";
  brokerProvider?: BrokerProvider;
  brokerAccountId?: string;
  strategyRuntimeId?: string;
  signalBarTime?: string;
  /** 迁移期兼容：仅显式开启时才同步写旧 intent_order。主链默认只写 order_intent。 */
  legacyDualWrite?: boolean;
}

function directionToSide(direction: ReiaOrderPayload["direction"]): "buy" | "sell" {
  if (direction === "short" || direction === "close") return "sell";
  return "buy";
}

export async function resolveExecutionStrategyContext(
  db: DbClient,
  workflowRunId: string,
  symbol: string,
  market: string,
): Promise<{ strategyVersionId: string; instrumentId: string; projectId: string }> {
  const runs = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1);
  const run = runs[0];
  if (!run) throw new Error("workflow_run_not_found");

  const strategies = await db
    .select()
    .from(strategy)
    .where(eq(strategy.projectId, run.projectId))
    .limit(1);
  let strat = strategies[0];
  if (!strat) {
    const sid = randomUUID();
    await db.insert(strategy).values({
      id: sid,
      projectId: run.projectId,
      name: "auto-bridge",
      style: "low_freq",
      description: "Created by REIA bridge",
    });
    strat = {
      id: sid,
      projectId: run.projectId,
      name: "auto-bridge",
      style: "low_freq",
      description: "",
    } as typeof strategy.$inferSelect;
  }

  const versions = await db
    .select()
    .from(strategyVersion)
    .where(eq(strategyVersion.strategyId, strat.id))
    .limit(1);
  let version = versions[0];
  if (!version) {
    const vid = randomUUID();
    await db.insert(strategyVersion).values({
      id: vid,
      strategyId: strat.id,
      versionTag: "v1",
      logicHash: "reia-bridge",
      paramSchemaJson: {},
      workflowRunId,
    });
    version = {
      id: vid,
      strategyId: strat.id,
      versionTag: "v1",
      logicHash: "reia-bridge",
      paramSchemaJson: {},
      workflowRunId,
    } as typeof strategyVersion.$inferSelect;
  }

  const instruments = await db
    .select()
    .from(instrument)
    .where(eq(instrument.symbol, symbol.trim().toUpperCase()))
    .limit(1);
  let inst = instruments[0];
  if (!inst) {
    const iid = randomUUID();
    await db.insert(instrument).values({
      id: iid,
      symbol: symbol.trim().toUpperCase(),
      assetClass: market === "CRYPTO" ? "crypto" : "stock",
      exchange: market,
      metaJson: {},
    });
    inst = {
      id: iid,
      symbol: symbol.trim().toUpperCase(),
      assetClass: market === "CRYPTO" ? "crypto" : "stock",
      exchange: market,
      metaJson: {},
    } as typeof instrument.$inferSelect;
  }

  return {
    strategyVersionId: version.id,
    instrumentId: inst.id,
    projectId: run.projectId,
  };
}

/** Unified path: REIA-style payload → order_intent + pre_trade_risk + execution_task. */
export async function createOrderIntentFromReiaPayload(
  input: ReiaOrderPayload,
  db?: DbClient
): Promise<CreateOrderIntentResult & { legacyIntentOrderId?: string }> {
  const client = db ?? (await getDb());
  const ctx = await resolveExecutionStrategyContext(
    client,
    input.workflowRunId,
    input.ticker,
    input.market ?? "US",
  );

  const legacyDualWrite =
    input.legacyDualWrite === true || process.env.QUBIT_LEGACY_INTENT_DUAL_WRITE === "1";
  let legacyId: string | undefined;
  if (legacyDualWrite) {
    legacyId = randomUUID();
    await client.insert(intentOrder).values({
      id: legacyId,
      workflowRunId: input.workflowRunId,
      createdByInstanceId: null,
      ticker: input.ticker,
      direction: input.direction,
      quantity: input.quantity,
      targetPrice: input.targetPrice,
      rationale: input.rationale ?? "",
      expectedReturn: null,
      expectedRisk: null,
      status: "approved",
      riskApprovedAt: new Date().toISOString(),
    });
  }

  const dispatchMode = input.executionMode === "live" ? "live" : "paper";

  const result = await createOrderIntentWithExecution(client, {
    workflowRunId: input.workflowRunId,
    strategyVersionId: ctx.strategyVersionId,
    instrumentId: ctx.instrumentId,
    side: directionToSide(input.direction),
    qty: input.quantity,
    orderType: "limit",
    price: input.targetPrice,
    timeInForce: "day",
    market: input.market ?? null,
    symbol: input.ticker,
    timeframe: input.timeframe ?? null,
    strategyRuntimeId: input.strategyRuntimeId ?? null,
    signalBarTime: input.signalBarTime ?? null,
    dispatchMode,
    brokerAccountId: input.brokerAccountId ?? null,
    traceId: randomUUID(),
  });

  return legacyId ? { ...result, legacyIntentOrderId: legacyId } : result;
}
