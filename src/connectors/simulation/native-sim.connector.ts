import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { executionReport, intentOrder } from "../../db/sqlite/schema";
import type { ConnectorMeta } from "../../types/connector";
import { BaseConnector } from "../base.connector";
import { createIntentOrder, executeIntentPaper } from "../../runtime/reia/intent-engine";

/**
 * Paper-trading simulation connector (wraps intent-engine paper execution).
 */
export class QubitNativeSimConnector extends BaseConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-sim",
    version: "0.1.0",
    connectorType: "execution",
    capabilities: ["submit_paper_order", "get_paper_position"],
    assetClasses: ["stock"],
    latencyProfile: "low",
    description: "Built-in paper trading via intent_order + execution_report.",
  };

  protected async onInit(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
  protected async onHealthcheck() {
    return { status: "healthy" as const, message: "qubit-sim: paper trading ready" };
  }

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (operation === "submit_paper_order") {
      const workflowRunId = String(p.workflowRunId ?? "");
      const ticker = String(p.ticker ?? p.symbol ?? "").trim();
      const quantity = Number(p.quantity ?? 0);
      const targetPrice = Number(p.targetPrice ?? p.price ?? 0);
      if (!workflowRunId) throw new Error("submit_paper_order: workflowRunId is required");
      if (!ticker) throw new Error("submit_paper_order: ticker is required");
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new Error("submit_paper_order: quantity must be positive");
      }
      const direction =
        p.direction === "short" || p.direction === "close"
          ? (p.direction as "short" | "close")
          : "long";
      const db = await getDb();
      const { id: intentOrderId } = await createIntentOrder({
        workflowRunId,
        ticker,
        direction,
        quantity,
        targetPrice: targetPrice > 0 ? targetPrice : 100,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
      });
      const exec = await executeIntentPaper({ intentOrderId });
      const reports = await db
        .select()
        .from(executionReport)
        .where(eq(executionReport.intentOrderId, intentOrderId))
        .limit(1);
      const report = reports[0];
      return {
        intentOrderId,
        status: "filled",
        executionReportId: exec.executionReportId,
        actualPrice: report?.actualPrice ?? targetPrice,
        actualQuantity: report?.actualQuantity ?? quantity,
      } as unknown as TOutput;
    }
    if (operation === "get_paper_position") {
      const workflowRunId = String(p.workflowRunId ?? "");
      const ticker = typeof p.ticker === "string" ? p.ticker.trim() : undefined;
      const db = await getDb();
      const intents = workflowRunId
        ? await db.select().from(intentOrder).where(eq(intentOrder.workflowRunId, workflowRunId))
        : await db.select().from(intentOrder).limit(50);
      const filled = intents.filter((i) => i.status === "approved" || i.status === "executed");
      const byTicker = new Map<string, { quantity: number; avgPrice: number }>();
      for (const intent of filled) {
        if (ticker && intent.ticker !== ticker) continue;
        const reports = await db
          .select()
          .from(executionReport)
          .where(eq(executionReport.intentOrderId, intent.id));
        const report = reports[0];
        if (!report) continue;
        const prev = byTicker.get(intent.ticker) ?? { quantity: 0, avgPrice: 0 };
        const sign = intent.direction === "short" ? -1 : 1;
        const qty = sign * report.actualQuantity;
        const newQty = prev.quantity + qty;
        const newAvg =
          newQty !== 0
            ? (prev.avgPrice * prev.quantity + report.actualPrice * qty) / newQty
            : report.actualPrice;
        byTicker.set(intent.ticker, { quantity: newQty, avgPrice: newAvg });
      }
      return {
        workflowRunId,
        positions: [...byTicker.entries()].map(([sym, pos]) => ({
          ticker: sym,
          quantity: pos.quantity,
          avgPrice: pos.avgPrice,
        })),
      } as unknown as TOutput;
    }
    throw new Error(`qubit-sim: unknown operation "${operation}"`);
  }
}
