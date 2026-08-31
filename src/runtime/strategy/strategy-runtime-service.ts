import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import {
  brokerAccount,
  indicatorStrategyScript,
  instrument,
  strategyPositionSnapshot,
  strategyRuntime,
  strategySignalDedup,
} from "../../db/sqlite/schema";
import type { OrderSide } from "../../types/entities";
import { strategyPromotionService } from "../effect-validation/strategy-promotion-service";
import { createOrderIntentWithExecution } from "../execution/order-intent-service";
import {
  assertLiveRuntimeGuardrailsForSymbol,
  type LiveRuntimeGuardrails,
} from "../execution/live-runtime-guardrails";
import { resolveInstrument } from "../market/instrument-router";
import { assertTradingModuleEnabled } from "../trader/trading-module-control";
import { appendStrategyRuntimeLog } from "./strategy-runtime-log";
import { ensureStrategyVersionForScript } from "./strategy-version-resolver";

export interface CreateStrategyRuntimeInput {
  strategyScriptId: string;
  market: string;
  symbol: string;
  timeframe?: string;
  executionMode?: "paper" | "live" | "sim";
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
  /** indicator (buy/sell arrays), script (on_bar), or Strategy API V2 contract */
  strategyMode?: "indicator" | "script" | "contract";
  /** Fixed capital used to translate contract target-percent/value signals. */
  paperCapital?: number;
  /** Bind paper evidence to this exact composition; required when a version has multiple recipes. */
  compositionId?: string;
  /** Alias accepted by the runtime API. */
  strategyCompositionId?: string;
  /**
   * Immutable research thesis used to authorize a live runtime's orders.
   * It is intentionally runtime configuration rather than an ephemeral worker
   * argument so every automated order can be traced back to the same thesis.
   */
  thesisId?: string;
  /**
   * Optional explicit snapshot. When omitted, the execution gate derives it
   * from thesisId and still validates freshness/quality for every order.
   */
  snapshotId?: string;
  /** Required when the configured thesis names an investment framework card. */
  frameworkAssessmentArtifactId?: string;
  /**
   * Required for real-money runtimes. This is a deployment-local envelope,
   * intentionally narrower than project-wide risk rules.
   */
  liveGuardrails?: LiveRuntimeGuardrails;
}

function asRuntimeParams(value: unknown): StrategyRuntimeParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as StrategyRuntimeParams;
}

/**
 * Do the inexpensive configuration check at admission time. The canonical
 * order-intent pipeline deliberately performs the authoritative thesis ↔
 * snapshot freshness and data-quality validation again for every live order:
 * evidence can expire while a long-lived runtime is idle.
 */
function assertLiveRuntimeEvidenceConfigured(
  params: StrategyRuntimeParams,
  symbol?: string
): void {
  if (!params.thesisId?.trim()) {
    throw new Error(
      "live_runtime_evidence_missing: params.thesisId is required for live strategy runtimes"
    );
  }
  if (symbol) assertLiveRuntimeGuardrailsForSymbol(params.liveGuardrails, symbol);
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
  const executionMode = input.executionMode ?? "paper";
  const runtimeParams = asRuntimeParams(input.params);
  // research-only 脚本允许 paper 本地引擎；sim/live 仍须 both/live_trading
  if (purpose === "research" && executionMode !== "paper") {
    throw new Error("strategy_script_not_enabled_for_live");
  }
  if (executionMode === "live") {
    assertLiveRuntimeEvidenceConfigured(runtimeParams, input.symbol.trim().toUpperCase());
  }

  const resolved = await resolveInstrument({
    market: input.market,
    symbol: input.symbol,
    ...(input.brokerAccountId !== undefined ? { brokerAccountId: input.brokerAccountId } : {}),
    lookupDefaultBroker: db == null,
  });

  let brokerAccountId = resolved.brokerAccountId;
  if ((executionMode === "sim" || executionMode === "live") && !brokerAccountId) {
    const { resolveDefaultSimBrokerAccountId } = await import(
      "../execution/resolve-sim-broker-account"
    );
    if (executionMode === "sim") {
      brokerAccountId = await resolveDefaultSimBrokerAccountId("futu", client);
      if (!brokerAccountId) {
        throw new Error(
          "sim_execution_requires_broker_account: configure an enabled Futu sandbox account"
        );
      }
    } else {
      throw new Error("live_execution_requires_broker_account");
    }
  }

  if (executionMode === "sim" && brokerAccountId) {
    const account = (
      await client
        .select({ enabled: brokerAccount.enabled, mode: brokerAccount.mode })
        .from(brokerAccount)
        .where(eq(brokerAccount.id, brokerAccountId))
        .limit(1)
    )[0];
    if (!account?.enabled || (account.mode !== "sandbox" && account.mode !== "mock")) {
      throw new Error("sim_execution_requires_sandbox_or_mock_broker_account");
    }
  }

  await assertTradingModuleEnabled(client, {
    ...(brokerAccountId ? { brokerAccountId } : {}),
  });

  const id = randomUUID();
  const now = new Date().toISOString();
  await client.insert(strategyRuntime).values({
    id,
    strategyScriptId: script.id,
    brokerAccountId,
    status: input.autoStart ? "starting" : "stopped",
    executionMode,
    market: resolved.market,
    symbol: resolved.symbol,
    timeframe: input.timeframe ?? "1d",
    paramsJson: runtimeParams,
    createdAt: now,
    updatedAt: now,
  });

  const row = (
    await client.select().from(strategyRuntime).where(eq(strategyRuntime.id, id)).limit(1)
  )[0];
  if (!row) throw new Error("strategy_runtime_create_failed");

  if (input.autoStart) {
    await startStrategyRuntime(id, client);
  }

  return row;
}

export async function startStrategyRuntime(runtimeId: string, db?: DbClient): Promise<void> {
  const client = db ?? (await getDb());
  const runtimeRows = await client
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.id, runtimeId))
    .limit(1);
  const runtime = runtimeRows[0];
  if (!runtime) throw new Error("strategy_runtime_not_found");
  await assertTradingModuleEnabled(client, {
    ...(runtime.brokerAccountId ? { brokerAccountId: runtime.brokerAccountId } : {}),
    strategyRuntimeId: runtime.id,
  });
  if (runtime.executionMode === "live") {
    assertLiveRuntimeEvidenceConfigured(asRuntimeParams(runtime.paramsJson), runtime.symbol);
    await strategyPromotionService.assertRuntimeLiveEligible(runtimeId, client);
  }
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

  if (!filter?.workflowRunId && !filter?.sessionId && !filter?.status) return rows;

  const out: typeof rows = [];
  for (const r of rows) {
    if (filter?.status && r.status !== filter.status) continue;
    const scripts = await db
      .select()
      .from(indicatorStrategyScript)
      .where(eq(indicatorStrategyScript.id, r.strategyScriptId))
      .limit(1);
    const script = scripts[0];
    if (!script) continue;
    if (filter.sessionId && script.sessionId !== filter.sessionId) continue;
    if (filter.workflowRunId && script.workflowRunId !== filter.workflowRunId) continue;
    out.push(r);
  }
  return out;
}

export async function recordSignalDedup(
  db: DbClient,
  input: {
    strategyRuntimeId: string;
    symbol: string;
    /** P2-E：与 OrderSide 对齐（信号方向等同于下单方向） */
    signalType: OrderSide;
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
    side: OrderSide;
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
  const dispatchMode =
    runtime.executionMode === "live" ? "live" : runtime.executionMode === "sim" ? "sim" : "paper";
  const runtimeParams = asRuntimeParams(runtime.paramsJson);

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
    ...(runtimeParams.thesisId !== undefined ? { thesisId: runtimeParams.thesisId } : {}),
    ...(runtimeParams.snapshotId !== undefined ? { snapshotId: runtimeParams.snapshotId } : {}),
    ...(runtimeParams.frameworkAssessmentArtifactId !== undefined
      ? { frameworkAssessmentArtifactId: runtimeParams.frameworkAssessmentArtifactId }
      : {}),
    // Live auto-trading always requires a tradable snapshot (Prime D3).
    // Sim (Futu sandbox) skips thesis gate for low-latency rule/factor loops.
    requireDataQualityGate: dispatchMode === "live",
    requireHumanConfirmation: dispatchMode === "live",
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
