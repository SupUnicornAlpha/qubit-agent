import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { alertEvent, brokerOrder, fill, orderIntent, workflowRun } from "../../db/sqlite/schema";
import type { BrokerProvider } from "../../types/broker";
import type { BrokerPosition } from "../reia/broker-connector";
import { brokerGetPositions } from "./broker/broker-service";

export interface InternalPositionFill {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
}

export interface PositionReconciliationRow {
  symbol: string;
  internalQty: number;
  brokerQty: number;
  quantityDelta: number;
  internalAvgPrice: number | null;
  brokerAvgPrice: number | null;
  averagePriceDeltaPct: number | null;
  notionalDelta: number | null;
  matched: boolean;
}

export function reconcilePositions(
  internalFills: InternalPositionFill[],
  brokerPositions: BrokerPosition[],
  quantityTolerance = 1e-8,
  priceTolerancePct = 0.001,
): PositionReconciliationRow[] {
  const internal = new Map<string, { qty: number; avgPrice: number }>();
  for (const fillRow of internalFills) {
    const symbol = fillRow.symbol.trim().toUpperCase();
    if (!symbol || !Number.isFinite(fillRow.qty) || !Number.isFinite(fillRow.price)) continue;
    const sign = fillRow.side === "sell" ? -1 : 1;
    const current = internal.get(symbol) ?? { qty: 0, avgPrice: 0 };
    const signedQty = sign * fillRow.qty;
    if (current.qty === 0 || Math.sign(current.qty) === Math.sign(signedQty)) {
      const nextQty = current.qty + signedQty;
      current.avgPrice =
        (Math.abs(current.qty) * current.avgPrice + Math.abs(signedQty) * fillRow.price) /
        Math.abs(nextQty);
      current.qty = nextQty;
    } else if (Math.abs(signedQty) < Math.abs(current.qty)) {
      current.qty += signedQty;
    } else if (Math.abs(signedQty) === Math.abs(current.qty)) {
      current.qty = 0;
      current.avgPrice = 0;
    } else {
      current.qty += signedQty;
      current.avgPrice = fillRow.price;
    }
    internal.set(symbol, current);
  }

  const broker = new Map<string, BrokerPosition>();
  for (const position of brokerPositions) {
    const symbol = position.symbol.trim().toUpperCase();
    if (symbol) broker.set(symbol, position);
  }

  const symbols = [...new Set([...internal.keys(), ...broker.keys()])].sort();
  return symbols.map((symbol) => {
    const internalPosition = internal.get(symbol) ?? { qty: 0, avgPrice: 0 };
    const brokerPosition = broker.get(symbol);
    const brokerQty = Number(brokerPosition?.qty ?? 0);
    const internalAvgPrice =
      Math.abs(internalPosition.qty) > quantityTolerance
        ? internalPosition.avgPrice
        : null;
    const brokerAvgPrice =
      brokerPosition && Number.isFinite(brokerPosition.avgPrice)
        ? Number(brokerPosition.avgPrice)
        : null;
    const quantityDelta = brokerQty - internalPosition.qty;
    const averagePriceDeltaPct =
      internalAvgPrice != null && internalAvgPrice > 0 && brokerAvgPrice != null
        ? (brokerAvgPrice - internalAvgPrice) / internalAvgPrice
        : null;
    const referencePrice = brokerAvgPrice ?? internalAvgPrice;
    return {
      symbol,
      internalQty: internalPosition.qty,
      brokerQty,
      quantityDelta,
      internalAvgPrice,
      brokerAvgPrice,
      averagePriceDeltaPct,
      notionalDelta: referencePrice == null ? null : quantityDelta * referencePrice,
      matched:
        Math.abs(quantityDelta) <= quantityTolerance &&
        (averagePriceDeltaPct == null || Math.abs(averagePriceDeltaPct) <= priceTolerancePct),
    };
  });
}

export async function buildPositionReconciliation(input: {
  projectId: string;
  provider: BrokerProvider;
  accountRef?: string;
  quantityTolerance?: number;
  priceTolerancePct?: number;
}) {
  const db = await getDb();
  const internalRows = await db
    .select({
      symbol: orderIntent.symbol,
      side: orderIntent.side,
      qty: fill.fillQty,
      price: fill.fillPrice,
    })
    .from(fill)
    .innerJoin(brokerOrder, eq(fill.brokerOrderId, brokerOrder.id))
    .innerJoin(orderIntent, eq(brokerOrder.orderIntentId, orderIntent.id))
    .innerJoin(workflowRun, eq(orderIntent.workflowRunId, workflowRun.id))
    .where(eq(workflowRun.projectId, input.projectId));
  const external = await brokerGetPositions({
    provider: input.provider,
    ...(input.accountRef ? { accountRef: input.accountRef } : {}),
  });
  const rows = reconcilePositions(
    internalRows
      .filter((row): row is typeof row & { symbol: string } => Boolean(row.symbol))
      .map((row) => ({ symbol: row.symbol, side: row.side, qty: row.qty, price: row.price })),
    external,
    input.quantityTolerance,
    input.priceTolerancePct,
  );
  const mismatches = rows.filter((row) => !row.matched);
  return {
    projectId: input.projectId,
    provider: input.provider,
    accountRef: input.accountRef ?? null,
    asof: new Date().toISOString(),
    summary: {
      symbols: rows.length,
      matched: rows.length - mismatches.length,
      mismatched: mismatches.length,
      matchRate: rows.length ? (rows.length - mismatches.length) / rows.length : 1,
      absoluteNotionalDelta: rows.reduce(
        (sum, row) => sum + Math.abs(row.notionalDelta ?? 0),
        0,
      ),
    },
    rows,
  };
}

export function positionReconciliationSeverity(input: {
  mismatched: number;
  symbols: number;
  absoluteNotionalDelta: number;
}): "warn" | "error" | "critical" {
  const mismatchRate = input.symbols > 0 ? input.mismatched / input.symbols : 0;
  if (mismatchRate >= 0.5 || input.absoluteNotionalDelta >= 100_000) return "critical";
  if (mismatchRate >= 0.2 || input.absoluteNotionalDelta >= 10_000) return "error";
  return "warn";
}

export function buildPositionRemediationPlan(
  report: Awaited<ReturnType<typeof buildPositionReconciliation>>,
) {
  const actions = report.rows
    .filter((row) => !row.matched && Math.abs(row.quantityDelta) > 1e-8)
    .map((row) => ({
      symbol: row.symbol,
      action: row.quantityDelta > 0 ? "sell" as const : "buy" as const,
      quantity: Math.abs(row.quantityDelta),
      estimatedNotional: Math.abs(row.notionalDelta ?? 0),
      reason: `broker_qty=${row.brokerQty}, internal_qty=${row.internalQty}`,
      requiresApproval: true,
    }));
  const hashPayload = {
    projectId: report.projectId,
    provider: report.provider,
    accountRef: report.accountRef,
    actions: actions.map((action) => ({
      symbol: action.symbol,
      action: action.action,
      quantity: action.quantity,
      estimatedNotional: action.estimatedNotional,
    })),
  };
  return {
    planHash: createHash("sha256").update(JSON.stringify(hashPayload)).digest("hex"),
    generatedAt: new Date().toISOString(),
    mode: "proposal_only" as const,
    actions,
    totalEstimatedNotional: actions.reduce((sum, action) => sum + action.estimatedNotional, 0),
    autoExecuted: false,
    approvalRequired: actions.length > 0,
  };
}

export async function scanPositionReconciliation(input: {
  projectId: string;
  provider: BrokerProvider;
  accountRef?: string;
}) {
  const report = await buildPositionReconciliation(input);
  const db = await getDb();
  const scopeId = `${input.projectId}:${input.provider}:${input.accountRef ?? "default"}`;
  const open = await db
    .select()
    .from(alertEvent)
    .where(
      and(
        eq(alertEvent.scopeType, "system"),
        eq(alertEvent.scopeId, scopeId),
        eq(alertEvent.alertType, "position_reconciliation_mismatch"),
        eq(alertEvent.status, "open"),
      ),
    )
    .limit(1);
  let alertId: string | null = open[0]?.id ?? null;
  if (report.summary.mismatched > 0 && !alertId) {
    alertId = randomUUID();
    await db.insert(alertEvent).values({
      id: alertId,
      scopeType: "system",
      scopeId,
      alertType: "position_reconciliation_mismatch",
      severity: positionReconciliationSeverity(report.summary),
      title: `券商持仓对账不一致：${input.provider} ${report.summary.mismatched}/${report.summary.symbols}`,
      detailsJson: report,
      status: "open",
    });
  } else if (report.summary.mismatched === 0 && alertId) {
    await db
      .update(alertEvent)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(eq(alertEvent.id, alertId));
  }
  return {
    report,
    remediation: buildPositionRemediationPlan(report),
    alert: {
      id: alertId,
      created: report.summary.mismatched > 0 && open.length === 0,
      resolved: report.summary.mismatched === 0 && open.length > 0,
    },
  };
}
