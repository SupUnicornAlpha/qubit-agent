import { createHash } from "node:crypto";
import type { DbClient } from "../../db/sqlite/client";
import { processExecutionTasks } from "./execution-worker";
import { createOrderIntentWithExecution } from "./order-intent-service";
import type { PortfolioAllocationRow } from "./portfolio-allocation-service";
import { resolveExecutionStrategyContext } from "./reia-bridge";

export interface PortfolioRebalanceOrder {
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  referencePrice: number;
}

export function buildPortfolioRebalancePlan(rows: PortfolioAllocationRow[]) {
  const orders = rows
    .flatMap((row): PortfolioRebalanceOrder[] => {
      const qty = Math.floor(Math.abs(row.rebalanceQty));
      if (qty < 1 || !Number.isFinite(row.price) || row.price <= 0) return [];
      return [
        {
          symbol: row.symbol.trim().toUpperCase(),
          side: row.rebalanceQty > 0 ? "buy" : "sell",
          qty,
          referencePrice: row.price,
        },
      ];
    })
    .sort(
      (left, right) =>
        left.symbol.localeCompare(right.symbol) || left.side.localeCompare(right.side)
    );
  const planHash = createHash("sha256").update(JSON.stringify(orders)).digest("hex");
  return { planHash, orders };
}

export async function executePortfolioRebalance(
  db: DbClient,
  input: {
    workflowRunId: string;
    market: string;
    rows: PortfolioAllocationRow[];
    expectedPlanHash: string;
    dispatchMode?: "paper" | "live";
    brokerAccountId?: string;
    thesisId?: string;
    snapshotId?: string;
    frameworkAssessmentArtifactId?: string;
  }
) {
  const plan = buildPortfolioRebalancePlan(input.rows);
  if (plan.planHash !== input.expectedPlanHash) throw new Error("portfolio_rebalance_plan_changed");
  const results = [];
  for (const order of plan.orders) {
    const context = await resolveExecutionStrategyContext(
      db,
      input.workflowRunId,
      order.symbol,
      input.market
    );
    results.push(
      await createOrderIntentWithExecution(db, {
        workflowRunId: input.workflowRunId,
        strategyVersionId: context.strategyVersionId,
        instrumentId: context.instrumentId,
        side: order.side,
        qty: order.qty,
        orderType: "market",
        price: order.referencePrice,
        timeInForce: "day",
        market: input.market,
        symbol: order.symbol,
        dispatchMode: input.dispatchMode ?? "paper",
        ...(input.brokerAccountId ? { brokerAccountId: input.brokerAccountId } : {}),
        ...(input.thesisId !== undefined ? { thesisId: input.thesisId } : {}),
        ...(input.snapshotId !== undefined ? { snapshotId: input.snapshotId } : {}),
        ...(input.frameworkAssessmentArtifactId !== undefined
          ? { frameworkAssessmentArtifactId: input.frameworkAssessmentArtifactId }
          : {}),
        requireDataQualityGate: input.dispatchMode === "live",
        clientOrderId: `rebalance:${plan.planHash}:${order.symbol}:${order.side}`,
      })
    );
  }
  await processExecutionTasks(db);
  return { ...plan, results };
}
