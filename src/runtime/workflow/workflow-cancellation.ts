/**
 * 用户主动“停止”工作流的进程内取消信号。
 *
 * DB 的 workflow_run.status='cancelled' 是持久化事实；这里的 AbortSignal 用来立即
 * 打断仍在等待的 LLM HTTP/SSE 请求，避免 UI 已停止但后台继续烧 token。新一轮复用
 * workflow 时必须 clear，确保长对话可以继续使用同一个 workflow id。
 */
const cancelled = new Set<string>();
const controllers = new Map<string, AbortController>();

export class WorkflowCancelledError extends Error {
  constructor(readonly workflowRunId: string) {
    super(`workflow cancelled by user: ${workflowRunId}`);
    this.name = "WorkflowCancelledError";
  }
}

export function getWorkflowCancellationSignal(workflowRunId: string): AbortSignal {
  let controller = controllers.get(workflowRunId);
  if (!controller || controller.signal.aborted) {
    controller = new AbortController();
    controllers.set(workflowRunId, controller);
    if (cancelled.has(workflowRunId)) {
      controller.abort(new WorkflowCancelledError(workflowRunId));
    }
  }
  return controller.signal;
}

export function requestWorkflowCancellation(workflowRunId: string): void {
  cancelled.add(workflowRunId);
  const controller = controllers.get(workflowRunId);
  if (controller && !controller.signal.aborted) {
    controller.abort(new WorkflowCancelledError(workflowRunId));
  }
}

export function isWorkflowCancellationRequested(workflowRunId: string): boolean {
  return cancelled.has(workflowRunId);
}

export function clearWorkflowCancellation(workflowRunId: string): void {
  cancelled.delete(workflowRunId);
  controllers.delete(workflowRunId);
}
