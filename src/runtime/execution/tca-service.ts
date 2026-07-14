import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  brokerOrder,
  executionTask,
  fill,
  orderIntent,
  strategy,
  strategyVersion,
} from "../../db/sqlite/schema";

export type RejectionCategory = "risk" | "broker" | "retry_exhausted" | "other";

export interface TcaObservation {
  orderIntentId: string;
  side: "buy" | "sell";
  intendedQty: number;
  intendedPrice: number | null;
  filledQty: number;
  averageFillPrice: number | null;
  fees: number;
  implementationShortfallPct: number | null;
  fillRatePct: number;
  submitLatencyMs: number | null;
  fillLatencyMs: number | null;
  totalLatencyMs: number | null;
  rejected: boolean;
  rejectionCategory: RejectionCategory | null;
  rejectionReason: string | null;
}

export function classifyRejection(reason: string | null): RejectionCategory | null {
  if (!reason) return null;
  const normalized = reason.toLowerCase();
  if (normalized.includes("risk") || normalized.includes("notional") || normalized.includes("review")) {
    return "risk";
  }
  if (normalized.includes("broker") || normalized.includes("rejected")) return "broker";
  if (normalized.includes("retry") || normalized.includes("timeout")) return "retry_exhausted";
  return "other";
}

export function summarizeTca(observations: TcaObservation[]) {
  const withShortfall = observations.filter(
    (item): item is TcaObservation & { implementationShortfallPct: number } =>
      item.implementationShortfallPct != null
  );
  const average = (values: number[]) =>
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    orderCount: observations.length,
    filledOrderCount: observations.filter((item) => item.filledQty > 0).length,
    averageFillRatePct: average(observations.map((item) => item.fillRatePct)),
    averageImplementationShortfallPct: average(
      withShortfall.map((item) => item.implementationShortfallPct)
    ),
    p95ImplementationShortfallPct: percentile(
      withShortfall.map((item) => item.implementationShortfallPct),
      0.95
    ),
    averageSubmitLatencyMs: average(
      observations.flatMap((item) => (item.submitLatencyMs == null ? [] : [item.submitLatencyMs])),
    ),
    p95SubmitLatencyMs: percentile(
      observations.flatMap((item) => (item.submitLatencyMs == null ? [] : [item.submitLatencyMs])),
      0.95,
    ),
    averageFillLatencyMs: average(
      observations.flatMap((item) => (item.fillLatencyMs == null ? [] : [item.fillLatencyMs])),
    ),
    p95TotalLatencyMs: percentile(
      observations.flatMap((item) => (item.totalLatencyMs == null ? [] : [item.totalLatencyMs])),
      0.95,
    ),
    rejectedOrderCount: observations.filter((item) => item.rejected).length,
    rejectionRatePct:
      observations.length > 0
        ? (observations.filter((item) => item.rejected).length / observations.length) * 100
        : 0,
    rejectionBreakdown: observations.reduce<Record<string, number>>((acc, item) => {
      if (item.rejectionCategory) {
        acc[item.rejectionCategory] = (acc[item.rejectionCategory] ?? 0) + 1;
      }
      return acc;
    }, {}),
    totalFees: observations.reduce((sum, item) => sum + item.fees, 0),
  };
}

export async function buildProjectTcaReport(input: { projectId: string; since?: string }) {
  const db = await getDb();
  const conditions = [eq(strategy.projectId, input.projectId)];
  if (input.since) conditions.push(gte(orderIntent.intentTime, input.since));
  const intents = await db
    .select({ intent: orderIntent })
    .from(orderIntent)
    .innerJoin(strategyVersion, eq(orderIntent.strategyVersionId, strategyVersion.id))
    .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
    .where(and(...conditions));
  const observations: TcaObservation[] = [];
  for (const { intent } of intents) {
    const orders = await db
      .select()
      .from(brokerOrder)
      .where(eq(brokerOrder.orderIntentId, intent.id));
    const tasks = await db
      .select()
      .from(executionTask)
      .where(eq(executionTask.orderIntentId, intent.id))
      .limit(1);
    const task = tasks[0];
    const fills = [];
    for (const order of orders) {
      fills.push(...(await db.select().from(fill).where(eq(fill.brokerOrderId, order.id))));
    }
    const filledQty = fills.reduce((sum, item) => sum + item.fillQty, 0);
    const averageFillPrice =
      filledQty > 0
        ? fills.reduce((sum, item) => sum + item.fillQty * item.fillPrice, 0) / filledQty
        : null;
    const intendedPrice = intent.price;
    const rawShortfall =
      intendedPrice && averageFillPrice
        ? ((averageFillPrice - intendedPrice) / intendedPrice) * 100
        : null;
    const submittedAt = earliestIso(orders.map((order) => order.submittedAt));
    const filledAt = earliestIso(fills.map((item) => item.filledAt));
    const rejected =
      intent.lifecycleStatus === "rejected" || task?.status === "rejected" || task?.status === "failed";
    const rejectionReason = rejected ? task?.lastError ?? "rejected_without_reason" : null;
    observations.push({
      orderIntentId: intent.id,
      side: intent.side,
      intendedQty: intent.qty,
      intendedPrice,
      filledQty,
      averageFillPrice,
      fees: fills.reduce((sum, item) => sum + item.fee, 0),
      implementationShortfallPct:
        rawShortfall == null ? null : intent.side === "sell" ? -rawShortfall : rawShortfall,
      fillRatePct: intent.qty > 0 ? Math.min(100, (filledQty / intent.qty) * 100) : 0,
      submitLatencyMs: durationMs(intent.intentTime, submittedAt),
      fillLatencyMs: durationMs(submittedAt, filledAt),
      totalLatencyMs: durationMs(intent.intentTime, filledAt),
      rejected,
      rejectionCategory: classifyRejection(rejectionReason),
      rejectionReason,
    });
  }
  return {
    projectId: input.projectId,
    since: input.since ?? null,
    ...summarizeTca(observations),
    observations,
  };
}

function earliestIso(values: string[]): string | null {
  if (values.length === 0) return null;
  return [...values].sort()[0] ?? null;
}

function durationMs(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const value = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? null;
}
