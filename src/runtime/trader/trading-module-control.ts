import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import {
  executionTask,
  executionTaskEvent,
  orderIntent,
  tradingModuleControl,
} from "../../db/sqlite/schema";

const GLOBAL_CONTROL_ID = "global";
const CANCELLABLE_TASK_STATUSES = [
  "pending",
  "held",
  "conditional_wait",
  "awaiting_review",
] as const;

function environmentAllowsTrading(): boolean {
  const raw = (process.env.QUBIT_TRADING_MODULE_ENABLED ?? "true").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export type TradingModuleStatus = {
  enabled: boolean;
  changedAt: string;
  reason: string | null;
  changedBy: string | null;
  revision: number;
  source: "database" | "environment" | "default";
  /** Which persisted gate produced the decision; global when inherited. */
  scopeKey: string;
};

/** A scoped pause can only narrow trading permissions; it never overrides global disable. */
export type TradingModuleScope = {
  brokerAccountId?: string | null;
  strategyRuntimeId?: string | null;
};

function normalizeScope(scope: TradingModuleScope = {}): TradingModuleScope {
  const brokerAccountId = scope.brokerAccountId?.trim() || undefined;
  const strategyRuntimeId = scope.strategyRuntimeId?.trim() || undefined;
  return { ...(brokerAccountId ? { brokerAccountId } : {}), ...(strategyRuntimeId ? { strategyRuntimeId } : {}) };
}

function scopeKey(scope: TradingModuleScope = {}): string {
  const normalized = normalizeScope(scope);
  if (normalized.strategyRuntimeId) return `strategy_runtime:${normalized.strategyRuntimeId}`;
  if (normalized.brokerAccountId) return `broker_account:${normalized.brokerAccountId}`;
  return GLOBAL_CONTROL_ID;
}

function scopeKeys(scope: TradingModuleScope = {}): string[] {
  const normalized = normalizeScope(scope);
  return [
    GLOBAL_CONTROL_ID,
    ...(normalized.brokerAccountId ? [`broker_account:${normalized.brokerAccountId}`] : []),
    ...(normalized.strategyRuntimeId ? [`strategy_runtime:${normalized.strategyRuntimeId}`] : []),
  ];
}

async function resolveDb(db?: DbClient): Promise<DbClient> {
  return db ?? (await getDb());
}

/** Environment disable has higher priority than the durable operator control. */
export async function getTradingModuleStatus(
  db?: DbClient,
  scope: TradingModuleScope = {}
): Promise<TradingModuleStatus> {
  if (!environmentAllowsTrading()) {
    return {
      enabled: false,
      changedAt: new Date().toISOString(),
      reason: "disabled_by_environment",
      changedBy: null,
      revision: 0,
      source: "environment",
      scopeKey: GLOBAL_CONTROL_ID,
    };
  }
  const client = await resolveDb(db);
  const keys = scopeKeys(scope);
  const rows = await client
    .select()
    .from(tradingModuleControl)
    .where(inArray(tradingModuleControl.id, keys));
  const byKey = new Map(rows.map((row) => [row.id, row]));
  const disabled = keys.map((key) => byKey.get(key)).find((row) => row?.enabled === false);
  if (disabled) {
    return {
      enabled: false,
      changedAt: disabled.changedAt,
      reason: disabled.reason ?? null,
      changedBy: disabled.changedBy ?? null,
      revision: disabled.revision,
      source: "database",
      scopeKey: disabled.id,
    };
  }
  const selected = byKey.get(scopeKey(scope)) ?? byKey.get(GLOBAL_CONTROL_ID);
  if (!selected) {
    return {
      enabled: true,
      changedAt: "",
      reason: null,
      changedBy: null,
      revision: 0,
      source: "default",
      scopeKey: GLOBAL_CONTROL_ID,
    };
  }
  return {
    enabled: selected.enabled,
    changedAt: selected.changedAt,
    reason: selected.reason ?? null,
    changedBy: selected.changedBy ?? null,
    revision: selected.revision,
    source: "database",
    scopeKey: selected.id,
  };
}

export async function setTradingModuleEnabled(
  enabled: boolean,
  options: { reason?: string; changedBy?: string; db?: DbClient; scope?: TradingModuleScope } = {}
): Promise<TradingModuleStatus> {
  const client = await resolveDb(options.db);
  const normalizedScope = normalizeScope(options.scope);
  if (normalizedScope.brokerAccountId && normalizedScope.strategyRuntimeId) {
    throw new Error("trading_module_scope_ambiguous");
  }
  const key = scopeKey(normalizedScope);
  const existing = (
    await client
      .select({ revision: tradingModuleControl.revision })
      .from(tradingModuleControl)
      .where(eq(tradingModuleControl.id, key))
      .limit(1)
  )[0];
  const now = new Date().toISOString();
  const nextRevision = (existing?.revision ?? 0) + 1;
  await client
    .insert(tradingModuleControl)
    .values({
      id: key,
      enabled,
      reason: options.reason?.trim() || null,
      changedBy: options.changedBy?.trim() || null,
      revision: nextRevision,
      changedAt: now,
    })
    .onConflictDoUpdate({
      target: tradingModuleControl.id,
      set: {
        enabled,
        reason: options.reason?.trim() || null,
        changedBy: options.changedBy?.trim() || null,
        revision: nextRevision,
        changedAt: now,
      },
    });
  return getTradingModuleStatus(client, normalizedScope);
}

export async function assertTradingModuleEnabled(
  db?: DbClient,
  scope: TradingModuleScope = {}
): Promise<void> {
  const status = await getTradingModuleStatus(db, scope);
  if (!status.enabled) {
    throw new Error(
      status.scopeKey === GLOBAL_CONTROL_ID
        ? "trading_module_paused"
        : `trading_module_paused:${status.scopeKey}`
    );
  }
}

/**
 * Cancels work that has not been sent to a broker. Broker-acknowledged orders
 * remain for reconciliation/cancel workflows; pause must never pretend they
 * disappeared.
 */
export async function cancelPendingTradingWork(
  db?: DbClient,
  nowIso = new Date().toISOString(),
  scope: TradingModuleScope = {}
): Promise<string[]> {
  const client = await resolveDb(db);
  const tasks = await client
    .select({
      id: executionTask.id,
      orderIntentId: executionTask.orderIntentId,
      brokerAccountId: executionTask.brokerAccountId,
      strategyRuntimeId: orderIntent.strategyRuntimeId,
    })
    .from(executionTask)
    .innerJoin(orderIntent, eq(executionTask.orderIntentId, orderIntent.id))
    .where(inArray(executionTask.status, [...CANCELLABLE_TASK_STATUSES]));
  const normalized = normalizeScope(scope);
  const matching = tasks.filter(
    (task) =>
      (!normalized.brokerAccountId || task.brokerAccountId === normalized.brokerAccountId) &&
      (!normalized.strategyRuntimeId || task.strategyRuntimeId === normalized.strategyRuntimeId)
  );
  const cancelledTaskIds: string[] = [];
  for (const task of matching) {
    const cancelled = await client
      .update(executionTask)
      .set({ status: "cancelled", lastError: "trading_module_paused", updatedAt: nowIso })
      .where(
        and(
          eq(executionTask.id, task.id),
          inArray(executionTask.status, [...CANCELLABLE_TASK_STATUSES])
        )
      )
      .returning({ id: executionTask.id });
    // A worker may acquire the task between scan and update. In that case do
    // not overwrite its lifecycle or emit a false cancellation event.
    if (cancelled.length === 0) continue;
    cancelledTaskIds.push(task.id);
    await client
      .update(orderIntent)
      .set({ lifecycleStatus: "cancelled", lifecycleUpdatedAt: nowIso })
      .where(eq(orderIntent.id, task.orderIntentId));
    await client.insert(executionTaskEvent).values({
      id: randomUUID(),
      executionTaskId: task.id,
      eventType: "cancel",
      eventPayloadJson: { reason: "trading_module_paused" },
      eventAt: nowIso,
    });
  }
  return cancelledTaskIds;
}

/** Test-only cleanup of the durable singleton. */
export async function resetTradingModuleForTest(db?: DbClient): Promise<void> {
  const client = await resolveDb(db);
  await client.delete(tradingModuleControl);
}
