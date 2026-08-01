/**
 * Stale A2A reconciler: when parent workflow is terminal, cancel open children.
 */

import { requestA2ATaskCancellation } from "./a2a-task-cancellation";
import { listOpenDelegatedA2ATasksForWorkflow } from "./a2a-task-service";

const TERMINAL_WORKFLOW = new Set(["completed", "partial", "failed", "cancelled"]);

export async function reconcileStaleA2aTasksForWorkflow(
  workflowId: string,
  parentStatus: string
): Promise<{ cancelled: number }> {
  if (!TERMINAL_WORKFLOW.has(parentStatus)) return { cancelled: 0 };
  try {
    const open = await listOpenDelegatedA2ATasksForWorkflow(workflowId);
    let cancelled = 0;
    for (const task of open) {
      try {
        await requestA2ATaskCancellation(
          task.id,
          `parent_terminal: parent workflow entered ${parentStatus}`
        );
        cancelled += 1;
      } catch (error) {
        console.warn(
          `[a2a-reconcile] cancel ${task.id} failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return { cancelled };
  } catch (error) {
    console.warn(
      `[a2a-reconcile] failed for ${workflowId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { cancelled: 0 };
  }
}
