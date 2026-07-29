import { describe, expect, test } from "bun:test";
import {
  clearWorkflowCancellation,
  getWorkflowCancellationSignal,
  isWorkflowCancellationRequested,
  requestWorkflowCancellation,
} from "../workflow-cancellation";

describe("workflow cancellation", () => {
  test("aborts the active provider signal and resets cleanly for a reused chat workflow", () => {
    const workflowId = "workflow-reused-chat";
    clearWorkflowCancellation(workflowId);
    const firstTurnSignal = getWorkflowCancellationSignal(workflowId);

    requestWorkflowCancellation(workflowId);

    expect(firstTurnSignal.aborted).toBe(true);
    expect(isWorkflowCancellationRequested(workflowId)).toBe(true);

    clearWorkflowCancellation(workflowId);
    const nextTurnSignal = getWorkflowCancellationSignal(workflowId);
    expect(nextTurnSignal.aborted).toBe(false);
    expect(isWorkflowCancellationRequested(workflowId)).toBe(false);
  });
});
