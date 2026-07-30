/**
 * Process-local cancellation for an A2A child task. This deliberately does not
 * cancel its parent workflow: a topology timeout means child data is unknown,
 * not that the user's orchestration must be killed.
 */
import { cancelA2ATask } from "./a2a-task-service";

const cancelledTaskIds = new Set<string>();

export async function requestA2ATaskCancellation(
  taskId: string,
  reason = "cancelled_by_parent"
): Promise<void> {
  cancelledTaskIds.add(taskId);
  // Keep the in-memory cooperative interrupt fast, while making cancellation
  // durable for a parent/UI reconnect after process restart.
  await cancelA2ATask(taskId, reason);
}

export function isA2ATaskCancellationRequested(taskId: string): boolean {
  return cancelledTaskIds.has(taskId);
}

export function clearA2ATaskCancellation(taskId: string): void {
  cancelledTaskIds.delete(taskId);
}
