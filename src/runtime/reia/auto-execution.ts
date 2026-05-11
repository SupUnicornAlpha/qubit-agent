import { createIntentOrder, executeIntentLive, executeIntentPaper } from "./intent-engine";
import { requestExecutionConfirmation } from "./safety-gate";

export interface ScheduledExecutionPayload {
  ticker: string;
  direction: "long" | "short" | "close";
  quantity: number;
  targetPrice: number;
  rationale?: string;
  expectedReturn?: number;
  expectedRisk?: number;
  brokerProvider?: "futu" | "ib";
}

export async function runAutoExecution(input: {
  workflowRunId: string;
  executionMode: "paper" | "live_with_confirm" | "live_direct";
  payload: ScheduledExecutionPayload;
}): Promise<{ intentOrderId: string; executionReportId?: string }> {
  const created = await createIntentOrder({
    workflowRunId: input.workflowRunId,
    ticker: input.payload.ticker,
    direction: input.payload.direction,
    quantity: input.payload.quantity,
    targetPrice: input.payload.targetPrice,
    rationale: input.payload.rationale,
    expectedReturn: input.payload.expectedReturn,
    expectedRisk: input.payload.expectedRisk,
  });

  if (input.executionMode === "paper") {
    const executed = await executeIntentPaper({ intentOrderId: created.id });
    return { intentOrderId: created.id, executionReportId: executed.executionReportId };
  }

  const provider = input.payload.brokerProvider ?? "futu";
  if (input.executionMode === "live_with_confirm") {
    await requestExecutionConfirmation(created.id);
    const executed = await executeIntentLive({
      intentOrderId: created.id,
      provider,
    });
    return {
      intentOrderId: created.id,
      executionReportId: executed.executionReportId,
    };
  }

  const executed = await executeIntentLive({
    intentOrderId: created.id,
    provider,
  });
  return { intentOrderId: created.id, executionReportId: executed.executionReportId };
}
