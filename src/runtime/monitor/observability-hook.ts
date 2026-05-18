import { createAlertsFromWorkflowQuality } from "./alert-service";
import { createWorkflowQualitySnapshot } from "./quality-metrics";

export type WorkflowTerminalStatus = "completed" | "failed";

/**
 * Fire-and-forget hook when a workflow reaches a terminal state.
 * Writes a quality snapshot and evaluates alert rules without blocking the caller.
 */
export function onWorkflowTerminal(workflowId: string, status: WorkflowTerminalStatus): void {
  void (async () => {
    try {
      const snapshot = await createWorkflowQualitySnapshot(workflowId);
      await createAlertsFromWorkflowQuality(workflowId, { status, snapshot });
    } catch (err) {
      console.warn(
        `[observability] terminal hook failed for workflow ${workflowId}:`,
        err instanceof Error ? err.message : err
      );
    }
  })();
}
