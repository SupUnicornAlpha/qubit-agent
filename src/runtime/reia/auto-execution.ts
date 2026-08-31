import { getDb } from "../../db/sqlite/client";
import type { BrokerProvider } from "../../types/broker";
import { processExecutionTasks } from "../execution/execution-worker";
import { createOrderIntentFromReiaPayload } from "../execution/reia-bridge";

export interface ScheduledExecutionPayload {
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  expectedReturn?: number;
  expectedRisk?: number;
  brokerProvider?: BrokerProvider;
  brokerAccountId?: string;
  /** Required for live modes; binds the order to a promoted strategy runtime. */
  strategyRuntimeId?: string;
  market?: string;
  timeframe?: string;
  thesisId?: string;
  snapshotId?: string;
  frameworkAssessmentArtifactId?: string;
}

export async function runAutoExecution(input: {
  workflowRunId: string;
  executionMode: "paper" | "live_with_confirm" | "live_direct";
  payload: ScheduledExecutionPayload;
}): Promise<{
  intentOrderId: string;
  executionReportId?: string;
  orderIntentId?: string;
  riskReviewTicketId?: string | null;
}> {
  const requiresHumanConfirmation = input.executionMode === "live_with_confirm";
  const created = await createOrderIntentFromReiaPayload({
    workflowRunId: input.workflowRunId,
    ticker: input.payload.ticker,
    direction: input.payload.direction,
    quantity: input.payload.quantity,
    targetPrice: input.payload.targetPrice,
    rationale: input.payload.rationale,
    market: input.payload.market,
    timeframe: input.payload.timeframe,
    executionMode:
      input.executionMode === "paper"
        ? "paper"
        : input.executionMode === "live_direct" || input.executionMode === "live_with_confirm"
          ? "live"
          : "paper",
    brokerProvider: input.payload.brokerProvider,
    ...(input.payload.brokerAccountId !== undefined
      ? { brokerAccountId: input.payload.brokerAccountId }
      : {}),
    ...(input.payload.strategyRuntimeId !== undefined
      ? { strategyRuntimeId: input.payload.strategyRuntimeId }
      : {}),
    ...(input.payload.thesisId !== undefined ? { thesisId: input.payload.thesisId } : {}),
    ...(input.payload.snapshotId !== undefined ? { snapshotId: input.payload.snapshotId } : {}),
    ...(input.payload.frameworkAssessmentArtifactId !== undefined
      ? { frameworkAssessmentArtifactId: input.payload.frameworkAssessmentArtifactId }
      : {}),
    ...(requiresHumanConfirmation ? { requireHumanConfirmation: true } : {}),
  });

  if (!requiresHumanConfirmation) {
    const db = await getDb();
    await processExecutionTasks(db);
  }

  return {
    intentOrderId: created.legacyIntentOrderId ?? created.orderIntentId,
    orderIntentId: created.orderIntentId,
    ...(created.riskReviewTicketId !== null
      ? { riskReviewTicketId: created.riskReviewTicketId }
      : {}),
  };
}
