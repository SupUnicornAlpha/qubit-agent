import { createAlertsFromWorkflowQuality } from "./alert-service";
import { createWorkflowQualitySnapshot } from "./quality-metrics";
import { consolidateFromWorkflow } from "../memory/memory-consolidation";

export type WorkflowTerminalStatus = "completed" | "failed";

/**
 * Fire-and-forget hook when a workflow reaches a terminal state.
 * Writes a quality snapshot, evaluates alert rules, and (M10.A1) consolidates
 * session-level work into midterm memory — all without blocking the caller.
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

    // M10.A1: only consolidate for *completed* workflows
    if (status === "completed") {
      try {
        const result = await consolidateFromWorkflow(workflowId);
        if (result.status === "completed" && result.midtermInserted > 0) {
          console.log(
            `[memory] consolidated workflow ${workflowId} → ${result.midtermInserted} midterm records`
          );
        }
      } catch (err) {
        console.warn(
          `[memory] consolidation failed for workflow ${workflowId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  })();
}
