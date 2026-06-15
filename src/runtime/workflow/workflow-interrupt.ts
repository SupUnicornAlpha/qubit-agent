/**
 * 用户发起的「协作式中断」信号（进程内）。
 *
 * 语义：用户在研究团队跑动时点「中断」→ requestInterrupt(workflowId) 置位；团队编排
 * 在下一个 wave 边界 consumeInterrupt 命中 → 起一个 free_form 的 team_orchestrator HITL
 * 停在断点等用户输入，再走既有恢复链续跑（见 hitl-service.pauseForUserInterrupt）。
 *
 * 为什么用进程内 Set 而非落库：中断只对「当前进程里正在跑的团队任务」有意义——HTTP
 * 端点与 agent-pool / runAnalystTeam 同进程（index.ts 单进程启动）。进程重启后正在跑的
 * 任务本就不在了（靠 checkpoint resume 重新派发），残留标记无意义，故不持久化。
 */
const pending = new Set<string>();

/** 标记某工作流"请求中断"。幂等。 */
export function requestInterrupt(workflowRunId: string): void {
  pending.add(workflowRunId);
}

/** 是否有未消费的中断请求（只读，不清除）。 */
export function isInterruptRequested(workflowRunId: string): boolean {
  return pending.has(workflowRunId);
}

/** 取走并清除中断请求；返回此前是否置位（check-and-clear，避免重复触发）。 */
export function consumeInterrupt(workflowRunId: string): boolean {
  return pending.delete(workflowRunId);
}
