import type { TaskAssignPayload } from "../../types/a2a";
import type { AgentGraphState } from "./state";

export type TaskProgressEvent = {
  phase: "start" | "reason" | "act" | "observe" | "heartbeat" | "other";
  iteration: number;
  detail?: string;
};

export type TaskProgressReporter = (event: TaskProgressEvent) => void | Promise<void>;

export function isTaskDeadlineExpired(
  payload: TaskAssignPayload,
  nowMs: number = Date.now()
): boolean {
  if (!payload.deadline) return false;
  const deadlineMs = Date.parse(payload.deadline);
  return Number.isFinite(deadlineMs) && nowMs >= deadlineMs;
}

export function terminateAtTaskDeadline(state: AgentGraphState): AgentGraphState {
  return {
    ...state,
    finalResponse: {
      status: "partial",
      reason: "task_deadline_exceeded",
      role: state.agentDefinition.role,
      iteration: state.iteration,
      answerText:
        "专家子任务达到调度截止时间，已停止继续发起新一轮工具或模型调用。该状态不代表底层数据源不可用。",
    },
  };
}

export function terminateByUser(state: AgentGraphState): AgentGraphState {
  return {
    ...state,
    finalResponse: {
      status: "terminated",
      reason: "user_cancelled",
      role: state.agentDefinition.role,
      iteration: state.iteration,
      answerText: "已按你的要求停止生成。",
    },
  };
}

export function terminateByTaskCancellation(state: AgentGraphState): AgentGraphState {
  return {
    ...state,
    finalResponse: {
      status: "terminated",
      reason: "a2a_task_cancelled",
      role: state.agentDefinition.role,
      iteration: state.iteration,
      answerText: "该专家子任务已因调度超时被停止；这不代表底层数据源不可用。",
    },
  };
}

/** A progress callback is observability-only and must never fail a task. */
export async function reportTaskProgress(
  reporter: TaskProgressReporter | undefined,
  event: TaskProgressEvent
): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(event);
  } catch (error) {
    console.warn(
      `[run-react-loop] onTaskProgress failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
