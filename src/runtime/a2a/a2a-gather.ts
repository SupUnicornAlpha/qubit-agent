/**
 * A2A request-reply gather（请求-应答关联层）。
 *
 * 背景：A2A 总线（messaging/bus.ts）是「即发即弃」的——`a2aRouter.send` 把消息
 * publish 出去就返回，handler 回的 `TASK_RESULT` 发给原 sender，但没有任何
 * `taskId → 等待中的 promise` 关联机制。orchestrator 想「派 N 个子任务、等 N 个
 * 回包」（research 团队 fan-out 就是这个形状）时无从下手——这正是历史上研究团队
 * 退化成「进程内 Promise.allSettled、根本不上总线」的根因。
 *
 * 本模块补上这个缺失原语：
 *   1. 进程级单例，懒订阅一次 `TASK_RESULT`；
 *   2. caller 先 `expect(taskIds)` 同步登记 deferred、拿到 Promise；
 *   3. 再 `a2aRouter.send` 把 TASK_ASSIGN 发出去；
 *   4. await 该 Promise 即拿到按 taskId 关联回来的所有结果（含超时兜底）。
 *
 * 必须「先 expect 再 send」：总线是进程内同步派发，handler 可能在 send 调用返回前
 * 就把 TASK_RESULT 回过来；若登记晚于回包就会漏接。`expect` 同步登记规避了这个竞态。
 */

import { a2aRouter } from "../../messaging/a2a";
import type { A2AMessageEnvelope, TaskResultPayload } from "../../types/a2a";

export interface GatheredResult {
  taskId: string;
  /** false = handler 回了失败回执，或本地超时（见 timedOut） */
  success: boolean;
  result: unknown;
  errorMessage?: string | null;
  /** 本地超时兜底命中（没等到任何 TASK_RESULT） */
  timedOut?: boolean;
}

interface Deferred {
  settle: (r: GatheredResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

class A2AGather {
  private readonly pending = new Map<string, Deferred>();
  private subscribed = false;

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    // 进程级单订阅：捕获总线上**所有** TASK_RESULT，按 taskId 命中等待中的 deferred。
    // 与 caller 是谁无关——即使 orchestrator handler 自己忽略 TASK_RESULT 也不影响这里。
    a2aRouter.on("TASK_RESULT", (msg) => this.onResult(msg));
  }

  private onResult(msg: A2AMessageEnvelope): void {
    const payload = msg.payload as TaskResultPayload | undefined;
    const taskId = payload?.taskId;
    if (!taskId) return;
    const d = this.pending.get(taskId);
    if (!d) return; // 不是本进程在等的任务（如 orchestrator 自己的 research_team_execute 回执）
    this.pending.delete(taskId);
    clearTimeout(d.timer);
    d.settle({
      taskId,
      success: Boolean(payload?.success),
      result: payload?.result ?? null,
      errorMessage: payload?.errorMessage ?? null,
    });
  }

  /**
   * 同步登记一批期望回包的 taskId，返回「全部到齐 / 超时」后 resolve 的 Promise。
   * 必须在 `a2aRouter.send` 发出对应 TASK_ASSIGN **之前**调用。
   */
  expect(taskIds: string[], opts: { timeoutMs: number }): Promise<Map<string, GatheredResult>> {
    this.ensureSubscribed();
    const results = new Map<string, GatheredResult>();
    const waits = taskIds.map(
      (taskId) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(taskId);
            results.set(taskId, {
              taskId,
              success: false,
              result: null,
              errorMessage: "a2a_gather_timeout",
              timedOut: true,
            });
            resolve();
          }, opts.timeoutMs);
          // setTimeout 句柄在某些运行时会 ref 住进程退出；node/bun 下 unref 让它不挡退出。
          (timer as { unref?: () => void }).unref?.();
          this.pending.set(taskId, {
            settle: (r) => {
              results.set(taskId, r);
              resolve();
            },
            timer,
          });
        })
    );
    return Promise.all(waits).then(() => results);
  }
}

let _gather: A2AGather | null = null;

export function getA2AGather(): A2AGather {
  if (!_gather) _gather = new A2AGather();
  return _gather;
}
