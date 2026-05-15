import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  instrument,
  strategy,
  strategyPositionSnapshot,
  strategyRuntime,
  strategySignalDedup,
  strategyVersion,
  workflowRun,
} from "../../db/sqlite/schema";
import { createOrderIntentWithExecution } from "../execution/order-intent-service";
import { resolveInstrument } from "../market/instrument-router";
import { appendStrategyRuntimeLog } from "./strategy-runtime-log";

export interface CreateStrategyRuntimeInput {
  strategyScriptId: string;
  market: string;
  symbol: string;
  timeframe?: string;
  executionMode?: "paper" | "live";
  brokerAccountId?: string | null;
  params?: Record<string, unknown>;
  autoStart?: boolean;
}

export interface StrategyRuntimeParams {
  barLimit?: number;
  orderQty?: number;
  tradingDays?: number[];
  tradingStart?: string;
  tradingEnd?: string;
  timezone?: string;
  /** indicator (buy/sell arrays) or script (on_bar) */
  strategyMode?: "indicator" | "script";
}

async function ensureInstrumentForSymbol(
  db: DbClient,
  symbol: string,
  market: string
): Promise<string> {
  const sym = symbol.trim().toUpperCase();
  const existing = await db.select().from(instrument).where(eq(instrument.symbol, sym)).limit(1);
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await db.insert(instrument).values({
    id,
    symbol: sym,
    assetClass: market === "CRYPTO" ? "crypto" : "stock",
    exchange: market,
    metaJson: {},
  });
  return id;
}

async function ensureStrategyVersionForScript(
  db: DbClient,
  script: typeof indicatorStrategyScript.$inferSelect
): Promise<{ strategyVersionId: string; workflowRunId: string }> {
  let workflowRunId = script.workflowRunId;
  if (!workflowRunId) {
    throw new Error("strategy_script_missing_workflow_run");
  }

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
      name: script.name,
      style: "low_freq",
      description: "",
    });
    strat = {
      id: sid,
      projectId: run.projectId,
      name: script.name,
      style: "low_freq",
      description: "",
    } as typeof strategy.$inferSelect;
  }

  const versions = await db
    .select()
    .from(strategyVersion)
    .where(eq(strategyVersion.strategyId, strat.id))
    .limit(1);
  if (versions[0]) {
    return { strategyVersionId: versions[0].id, workflowRunId };
  }

  const vid = randomUUID();
  await db.insert(strategyVersion).values({
    id: vid,
    strategyId: strat.id,
    versionTag: "v1",
    logicHash: `script-${script.id.slice(0, 8)}`,
    paramSchemaJson: {},
  });
  return { strategyVersionId: vid, workflowRunId };
}

export async function createStrategyRuntime(
  input: CreateStrategyRuntimeInput,
  db?: DbClient
): Promise<typeof strategyRuntime.$inferSelect> {
  const client = db ?? (await getDb());

  const scripts = await client
    .select()
    .from(indicatorStrategyScript)
    .where(eq(indicatorStrategyScript.id, input.strategyScriptId))
    .limit(1);
  const script = scripts[0];
  if (!script) throw new Error("strategy_script_not_found");

  const purpose = script.purpose ?? "both";
  if (purpose === "research") {
    throw new Error("strategy_script_not_enabled_for_live");
  }

  const resolved = await resolveInstrument({
    market: input.market,
    symbol: input.symbol,
    brokerAccountId: input.brokerAccountId,
  });

  const id = randomUUID();
  const now = new Date().toISOString();
  await client.insert(strategyRuntime).values({
    id,
    strategyScriptId: script.id,
    brokerAccountId: resolved.brokerAccountId,
    status: input.autoStart ? "starting" : "stopped",
    executionMode: input.executionMode ?? "paper",
    market: resolved.market,
    symbol: resolved.symbol,
    timeframe: input.timeframe ?? "1d",
    paramsJson: input.params ?? {},
    createdAt: now,
    updatedAt: now,
  });

  const row = (await client.select().from(strategyRuntime).where(eq(strategyRuntime.id, id)).limit(1))[0]!;

  if (input.autoStart) {
    await startStrategyRuntime(id, client);
  }

  return row;
}

export async function startStrategyRuntime(runtimeId: string, db?: DbClient): Promise<void> {
  const client = db ?? (await getDb());
  const now = new Date().toISOString();
  await client
    .update(strategyRuntime)
    .set({ status: "running", errorMessage: null, updatedAt: now })
    .where(eq(strategyRuntime.id, runtimeId));

  await appendStrategyRuntimeLog(client, {
    strategyRuntimeId: runtimeId,
    level: "info",
    message: "strategy_runtime_started",
  });
}

export async function stopStrategyRuntime(runtimeId: string, db?: DbClient): Promise<void> {
  const client = db ?? (await getDb());
  const now = new Date().toISOString();
  await client
    .update(strategyRuntime)
    .set({ status: "stopped", updatedAt: now })
    .where(eq(strategyRuntime.id, runtimeId));

  await appendStrategyRuntimeLog(client, {
    strategyRuntimeId: runtimeId,
    level: "info",
    message: "strategy_runtime_stopped",
  });
}

export async function getStrategyRuntime(runtimeId: string, db?: DbClient) {
  const client = db ?? (await getDb());
  const rows = await client
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.id, runtimeId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listStrategyRuntimes(filter?: {
  workflowRunId?: string;
  sessionId?: string;
  status?: string;
}) {
  const db = await getDb();
  const rows = await db.select().from(strategyRuntime).orderBy(desc(strategyRuntime.updatedAt));

  if (!filter?.workflowRunId && !filter?.sessionId) return rows;

  const out: typeof rows = [];
  for (const r of rows) {
    const scripts = await db
      .select()
      .from(indicatorStrategyScript)
      .where(eq(indicatorStrategyScript.id, r.strategyScriptId))
      .limit(1);
    const script = scripts[0];
    if (!script) continue;
    if (filter.sessionId && script.sessionId !== filter.sessionId) continue;
    if (filter.workflowRunId && script.workflowRunId !== filter.workflowRunId) continue;
    if (filter.status && r.status !== filter.status) continue;
    out.push(r);
  }
  return out;
}

export async function recordSignalDedup(
  db: DbClient,
  input: {
    strategyRuntimeId: string;
    symbol: string;
    signalType: "buy" | "sell";
    signalBarTime: string;
  }
): Promise<boolean> {
  try {
    await db.insert(strategySignalDedup).values({
      id: randomUUID(),
      strategyRuntimeId: input.strategyRuntimeId,
      symbol: input.symbol,
      signalType: input.signalType,
      signalBarTime: input.signalBarTime,
    });
    return true;
  } catch {
    return false;
  }
}

export async function submitRuntimeOrder(
  db: DbClient,
  runtime: typeof strategyRuntime.$inferSelect,
  input: {
    side: "buy" | "sell";
    qty: number;
    price: number;
    signalBarTime: string;
  }
): Promise<{ orderIntentId: string }> {
  const scripts = await db
    .select()
    .from(indicatorStrategyScript)
    .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
    .limit(1);
  const script = scripts[0];
  if (!script) throw new Error("strategy_script_not_found");

  const { strategyVersionId, workflowRunId } = await ensureStrategyVersionForScript(db, script);
  const instrumentId = await ensureInstrumentForSymbol(db, runtime.symbol, runtime.market);
  const dispatchMode = runtime.executionMode === "live" ? "live" : "paper";

  const result = await createOrderIntentWithExecution(db, {
    workflowRunId,
    strategyVersionId,
    instrumentId,
    side: input.side,
    qty: input.qty,
    orderType: "limit",
    price: input.price,
    timeInForce: "day",
    market: runtime.market,
    symbol: runtime.symbol,
    timeframe: runtime.timeframe,
    strategyRuntimeId: runtime.id,
    signalBarTime: input.signalBarTime,
    dispatchMode,
    brokerAccountId: runtime.brokerAccountId,
  });

  if (result.riskOutcome === "block") {
    throw new Error(`risk_blocked: ${result.riskReason}`);
  }

  if (input.side === "buy") {
    const snapId = randomUUID();
    const existing = await db
      .select()
      .from(strategyPositionSnapshot)
      .where(
        and(
          eq(strategyPositionSnapshot.strategyRuntimeId, runtime.id),
          eq(strategyPositionSnapshot.symbol, runtime.symbol)
        )
      )
      .limit(1);
    if (existing[0]) {
      await db
        .update(strategyPositionSnapshot)
        .set({
          qty: existing[0].qty + input.qty,
          avgPrice: input.price,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(strategyPositionSnapshot.id, existing[0].id));
    } else {
      await db.insert(strategyPositionSnapshot).values({
        id: snapId,
        strategyRuntimeId: runtime.id,
        symbol: runtime.symbol,
        qty: input.qty,
        avgPrice: input.price,
      });
    }
  } else {
    const existing = await db
      .select()
      .from(strategyPositionSnapshot)
      .where(
        and(
          eq(strategyPositionSnapshot.strategyRuntimeId, runtime.id),
          eq(strategyPositionSnapshot.symbol, runtime.symbol)
        )
      )
      .limit(1);
    if (existing[0]) {
      const nextQty = Math.max(0, existing[0].qty - input.qty);
      await db
        .update(strategyPositionSnapshot)
        .set({ qty: nextQty, updatedAt: new Date().toISOString() })
        .where(eq(strategyPositionSnapshot.id, existing[0].id));
    }
  }

  return { orderIntentId: result.orderIntentId };
}
