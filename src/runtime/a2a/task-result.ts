import type { TaskResultPayload } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";

/** 构造 A2A `TASK_RESULT` payload（Graph / A2A 共用） */
export function buildTaskResult(
  taskId: string,
  role: AgentRole | string,
  options?: {
    success?: boolean;
    result?: Record<string, unknown>;
    errorMessage?: string;
  }
): TaskResultPayload {
  const success = options?.success ?? true;
  const extra = options?.result ?? {};
  return {
    taskId,
    success,
    result: {
      handledByRole: role,
      ...extra,
    },
    errorMessage: options?.errorMessage,
    durationMs: 0,
  };
}
