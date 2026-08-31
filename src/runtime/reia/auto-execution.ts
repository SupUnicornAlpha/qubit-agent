import { getDb } from "../../db/sqlite/client";
import type { BrokerProvider } from "../../types/broker";
import { processExecutionTasks } from "../execution/execution-worker";
import { createOrderIntentFromReiaPayload } from "../execution/reia-bridge";
import { requestExecutionConfirmation } from "./safety-gate";

export interface ScheduledExecutionPayload {
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  expectedReturn?: number;
  expectedRisk?: number;
  brokerProvider?: BrokerProvider;
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
}): Promise<{ intentOrderId: string; executionReportId?: string; orderIntentId?: string }> {
  if (input.executionMode === "live_with_confirm") {
    const pre = await createOrderIntentFromReiaPayload({
      workflowRunId: input.workflowRunId,
      ticker: input.payload.ticker,
      direction: input.payload.direction,
      quantity: input.payload.quantity,
      targetPrice: input.payload.targetPrice,
      rationale: input.payload.rationale,
      market: input.payload.market,
      timeframe: input.payload.timeframe,
      executionMode: "paper",
      brokerProvider: input.payload.brokerProvider,
      ...(input.payload.thesisId !== undefined ? { thesisId: input.payload.thesisId } : {}),
      ...(input.payload.snapshotId !== undefined ? { snapshotId: input.payload.snapshotId } : {}),
      ...(input.payload.frameworkAssessmentArtifactId !== undefined
        ? { frameworkAssessmentArtifactId: input.payload.frameworkAssessmentArtifactId }
        : {}),
    });
    if (pre.legacyIntentOrderId) {
      await requestExecutionConfirmation(pre.legacyIntentOrderId);
    }
  }

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
    ...(input.payload.thesisId !== undefined ? { thesisId: input.payload.thesisId } : {}),
    ...(input.payload.snapshotId !== undefined ? { snapshotId: input.payload.snapshotId } : {}),
    ...(input.payload.frameworkAssessmentArtifactId !== undefined
      ? { frameworkAssessmentArtifactId: input.payload.frameworkAssessmentArtifactId }
      : {}),
  });

  const db = await getDb();
  await processExecutionTasks(db);

  return {
    intentOrderId: created.legacyIntentOrderId ?? created.orderIntentId,
    orderIntentId: created.orderIntentId,
  };
}
