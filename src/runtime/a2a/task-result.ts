import type { TaskResultPayload, TaskResultStatus } from "../../types/a2a";
import type { AgentRole } from "../../types/entities";

/** 构造 A2A `TASK_RESULT` payload（Graph / A2A 共用） */
export function buildTaskResult(
  taskId: string,
  role: AgentRole | string,
  options?: {
    success?: boolean;
    result?: Record<string, unknown>;
    errorMessage?: string;
    errorCode?: string;
    status?: TaskResultStatus;
    durationMs?: number;
    evidence?: TaskResultPayload["evidence"] | undefined;
    summary?: string | undefined;
  }
): TaskResultPayload {
  const status = options?.status ?? (options?.success === false ? "failed" : "completed");
  const success = status === "completed";
  const extra = options?.result ?? {};
  const errorCode = options?.errorCode ?? (success ? undefined : "task_failed");
  const errorMessage = options?.errorMessage ?? (success ? undefined : "任务未完成");
  return {
    taskId,
    success,
    status,
    result: {
      handledByRole: role,
      ...extra,
    },
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(options?.evidence ? { evidence: options.evidence } : {}),
    ...(options?.summary?.trim() ? { summary: options.summary.trim() } : {}),
    durationMs: Math.max(0, Math.floor(options?.durationMs ?? 0)),
  };
}
