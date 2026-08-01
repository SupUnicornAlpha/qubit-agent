/**
 * Ports that domain tools may use without importing a2a/react implementations.
 */

import type { A2ATaskState } from "../../types/a2a";

export type A2aWaitResult = {
  task: { id: string; status: A2ATaskState; result?: unknown; error?: unknown } | null;
  timedOut: boolean;
  timeoutReason?: "wall_clock" | "lease_expired";
};

export type A2aPorts = {
  waitForTerminal: (
    taskId: string,
    opts: { timeoutMs: number; leaseMs: number; pollMs?: number }
  ) => Promise<A2aWaitResult>;
  requestCancellation: (
    taskId: string,
    meta?: { reason?: string; detail?: string }
  ) => Promise<void> | void;
};

let _ports: A2aPorts | null = null;

export function getA2aPorts(): A2aPorts {
  if (_ports) return _ports;
  // Lazy default wiring — keeps tools compile-time free of a2a imports at call sites
  // that only need the port type; first use binds real impl.
  const ports: A2aPorts = {
    async waitForTerminal(taskId, opts) {
      const { waitForA2ATaskTerminal } = await import("./a2a-task-service");
      const result = await waitForA2ATaskTerminal(taskId, opts);
      return {
        task: result.task
          ? {
              id: result.task.id,
              status: result.task.status,
              result: result.task.result,
              error: result.task.error,
            }
          : null,
        timedOut: result.timedOut,
        ...(result.timeoutReason ? { timeoutReason: result.timeoutReason } : {}),
      };
    },
    async requestCancellation(taskId, meta) {
      const { requestA2ATaskCancellation } = await import("./a2a-task-cancellation");
      const reason = [meta?.reason, meta?.detail].filter(Boolean).join(": ") || "cancelled_by_parent";
      await requestA2ATaskCancellation(taskId, reason);
    },
  };
  _ports = ports;
  return ports;
}
