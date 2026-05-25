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
import type { BrokerProvider } from "../reia/broker-types";
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
}

function directionToSide(direction: ReiaOrderPayload["direction"]): "buy" | "sell" {
  if (direction === "short" || direction === "close") return "sell";
  return "buy";
}

async function resolveStrategyContext(
  db: DbClient,
  workflowRunId: string
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
    .where(eq(instrument.symbol, "BRIDGE"))
    .limit(1);
  let inst = instruments[0];
  if (!inst) {
    const iid = randomUUID();
    await db.insert(instrument).values({
      id: iid,
      symbol: "BRIDGE",
      assetClass: "stock",
      exchange: "BRIDGE",
      metaJson: {},
    });
    inst = {
      id: iid,
      symbol: "BRIDGE",
      assetClass: "stock",
      exchange: "BRIDGE",
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
  const ctx = await resolveStrategyContext(client, input.workflowRunId);

  const legacyId = randomUUID();
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

  return { ...result, legacyIntentOrderId: legacyId };
}
