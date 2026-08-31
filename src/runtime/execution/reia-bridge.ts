import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  instrument,
  intentOrder,
  strategy,
  strategyRuntime,
  strategyVersion,
  workflowRun,
} from "../../db/sqlite/schema";
import type { BrokerProvider } from "../../types/broker";
import { ensureStrategyVersionForScript } from "../strategy/strategy-version-resolver";
import {
  type CreateOrderIntentResult,
  createOrderIntentWithExecution,
} from "./order-intent-service";

export interface ReiaOrderPayload {
  workflowRunId: string;
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  market?: string;
  timeframe?: string;
  /** paper=本地假成交；sim=券商模拟盘(Futu sandbox)；live=真钱 */
  executionMode?: "paper" | "live" | "sim";
  brokerProvider?: BrokerProvider;
  brokerAccountId?: string;
  strategyRuntimeId?: string;
  signalBarTime?: string;
  /** Immutable research thesis required by the canonical live execution gate. */
  thesisId?: string;
  /** Optional explicit snapshot; the gate derives it from thesisId when omitted. */
  snapshotId?: string;
  frameworkAssessmentArtifactId?: string;
  /** Hold a promoted live order until the canonical human-review ticket is approved. */
  requireHumanConfirmation?: boolean;
  /** 迁移期兼容：仅显式开启时才同步写旧 intent_order。主链默认只写 order_intent。 */
  legacyDualWrite?: boolean;
}

export type RuntimeBoundExecutionContext = {
  workflowRunId: string;
  strategyVersionId: string;
  instrumentId: string;
  projectId: string;
  brokerAccountId: string | null;
  thesisId: string | null;
  snapshotId: string | null;
  frameworkAssessmentArtifactId: string | null;
};

function directionToSide(direction: ReiaOrderPayload["direction"]): "buy" | "sell" {
  if (direction === "short" || direction === "close") return "sell";
  return "buy";
}

export async function resolveExecutionStrategyContext(
  db: DbClient,
  workflowRunId: string,
  symbol: string,
  market: string
): Promise<{ strategyVersionId: string; instrumentId: string; projectId: string }> {
  const runs = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
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

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runtimeEvidence(
  value: unknown
): Pick<RuntimeBoundExecutionContext, "thesisId" | "snapshotId" | "frameworkAssessmentArtifactId"> {
  const params =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    thesisId: optionalString(params.thesisId),
    snapshotId: optionalString(params.snapshotId),
    frameworkAssessmentArtifactId: optionalString(params.frameworkAssessmentArtifactId),
  };
}

/**
 * Resolve an operator order against its originating strategy runtime.
 *
 * A runtime is the immutable deployment context for a strategy script.  In
 * particular, callers may not attach an arbitrary thesis/snapshot to it: live
 * evidence is read from the runtime configuration so the resulting intent has
 * the same strategy version and evidence lineage as automated runtime orders.
 */
export async function resolveRuntimeBoundExecutionContext(
  db: DbClient,
  input: Pick<
    ReiaOrderPayload,
    "strategyRuntimeId" | "ticker" | "market" | "executionMode" | "brokerAccountId"
  >
): Promise<RuntimeBoundExecutionContext | null> {
  const runtimeId = input.strategyRuntimeId?.trim();
  if (!runtimeId) return null;
  const runtimeRows = await db
    .select()
    .from(strategyRuntime)
    .where(eq(strategyRuntime.id, runtimeId))
    .limit(1);
  const runtime = runtimeRows[0];
  if (!runtime) throw new Error("strategy_runtime_not_found");

  const symbol = input.ticker.trim().toUpperCase();
  const market = (input.market ?? "US").trim().toUpperCase();
  if (
    runtime.symbol.trim().toUpperCase() !== symbol ||
    runtime.market.trim().toUpperCase() !== market
  ) {
    throw new Error("strategy_runtime_instrument_mismatch");
  }
  const requestedMode = input.executionMode ?? "paper";
  if (runtime.executionMode !== requestedMode) {
    throw new Error("strategy_runtime_execution_mode_mismatch");
  }
  if (input.brokerAccountId?.trim() && runtime.brokerAccountId !== input.brokerAccountId.trim()) {
    throw new Error("strategy_runtime_broker_account_mismatch");
  }
  if (requestedMode === "live" && !runtime.brokerAccountId) {
    throw new Error("live_execution_requires_broker_account");
  }

  const scripts = await db
    .select()
    .from(indicatorStrategyScript)
    .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
    .limit(1);
  const script = scripts[0];
  if (!script) throw new Error("strategy_script_not_found");
  const version = await ensureStrategyVersionForScript(db, script);
  const instruments = await db
    .select()
    .from(instrument)
    .where(eq(instrument.symbol, symbol))
    .limit(1);
  const inst = instruments[0];
  if (!inst) throw new Error("strategy_runtime_instrument_not_registered");
  const workflowRows = await db
    .select({ projectId: workflowRun.projectId })
    .from(workflowRun)
    .where(eq(workflowRun.id, version.workflowRunId))
    .limit(1);
  const projectId = workflowRows[0]?.projectId;
  if (!projectId) throw new Error("workflow_project_not_found");

  return {
    workflowRunId: version.workflowRunId,
    strategyVersionId: version.strategyVersionId,
    instrumentId: inst.id,
    projectId,
    brokerAccountId: runtime.brokerAccountId,
    ...runtimeEvidence(runtime.paramsJson),
  };
}

/** Unified path: REIA-style payload → order_intent + pre_trade_risk + execution_task. */
export async function createOrderIntentFromReiaPayload(
  input: ReiaOrderPayload,
  db?: DbClient
): Promise<CreateOrderIntentResult & { legacyIntentOrderId?: string }> {
  const client = db ?? (await getDb());
  const { parseDispatchMode } = await import("./live-trading-gate");
  const dispatchMode = parseDispatchMode(input.executionMode ?? "paper");
  const runtimeContext = await resolveRuntimeBoundExecutionContext(client, input);
  if (dispatchMode === "live" && !runtimeContext) {
    // Legacy auto-bridge rows are acceptable for paper/sim migration, but a
    // real-money order must name the frozen strategy runtime it deploys.
    throw new Error("live_execution_requires_strategy_runtime");
  }
  const legacyContext = runtimeContext
    ? null
    : await resolveExecutionStrategyContext(
        client,
        input.workflowRunId,
        input.ticker,
        input.market ?? "US"
      );
  const ctx = runtimeContext ?? legacyContext;

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

  let brokerAccountId = runtimeContext?.brokerAccountId ?? input.brokerAccountId ?? null;
  if (dispatchMode === "sim" && !brokerAccountId) {
    const { resolveDefaultSimBrokerAccountId } = await import("./resolve-sim-broker-account");
    brokerAccountId = await resolveDefaultSimBrokerAccountId(
      input.brokerProvider === "ib" || input.brokerProvider === "supermind"
        ? input.brokerProvider
        : "futu"
    );
    if (!brokerAccountId) {
      throw new Error(
        "sim_execution_requires_broker_account: configure an enabled Futu sandbox account"
      );
    }
  }

  const result = await createOrderIntentWithExecution(client, {
    // Runtime-bound orders are attributed to the strategy's source workflow,
    // not to an arbitrary UI/chat session that happened to submit them.
    workflowRunId: runtimeContext?.workflowRunId ?? input.workflowRunId,
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
    brokerAccountId,
    // Runtime evidence is authoritative.  Request payload evidence is kept
    // only for legacy paper/sim paths without a strategy runtime.
    thesisId: runtimeContext?.thesisId ?? input.thesisId ?? null,
    snapshotId: runtimeContext?.snapshotId ?? input.snapshotId ?? null,
    frameworkAssessmentArtifactId:
      runtimeContext?.frameworkAssessmentArtifactId ?? input.frameworkAssessmentArtifactId ?? null,
    requireDataQualityGate: dispatchMode === "live",
    requireHumanConfirmation: input.requireHumanConfirmation === true,
    traceId: randomUUID(),
  });

  return legacyId ? { ...result, legacyIntentOrderId: legacyId } : result;
}
