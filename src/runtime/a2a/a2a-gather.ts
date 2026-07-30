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
 *   1. 进程级单例，懒订阅一次 `TASK_RESULT` + `TASK_PROGRESS`；
 *   2. caller 先 `expect(taskIds)` 同步登记 deferred、拿到 Promise；
 *   3. 再 `a2aRouter.send` 把 TASK_ASSIGN 发出去；
 *   4. await 该 Promise 即拿到按 taskId 关联回来的所有结果（含超时兜底）。
 *
 * 超时模型（双时钟）：
 *   - wall clock（timeoutMs）：任务硬上限，progress 也不能突破；
 *   - lease（leaseMs）：连续无 TASK_PROGRESS 视为通信失联；progress/心跳续期。
 *
 * 必须「先 expect 再 send」：总线是进程内同步派发，handler 可能在 send 调用返回前
 * 就把 TASK_RESULT 回过来；若登记晚于回包就会漏接。`expect` 同步登记规避了这个竞态。
 */

import { a2aRouter } from "../../messaging/a2a";
import type {
  A2AMessageEnvelope,
  TaskProgressPayload,
  TaskResultPayload,
  TaskResultStatus,
} from "../../types/a2a";

export interface GatheredResult {
  taskId: string;
  /** false = handler 回了失败回执，或本地超时（见 timedOut） */
  success: boolean;
  result: unknown;
  errorMessage?: string | null;
  errorCode?: string | null;
  status?: TaskResultStatus;
  /** 本地超时兜底命中（没等到任何 TASK_RESULT） */
  timedOut?: boolean;
  /** 超时原因：墙钟 / 通信 lease 失联 */
  timeoutReason?: "wall_clock" | "lease_expired";
}

interface Deferred {
  settle: (r: GatheredResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
  wallDeadlineMs: number;
  leaseMs: number;
  lastProgressAtMs: number;
  settled: boolean;
  armTimer: () => void;
}

class A2AGather {
  private readonly pending = new Map<string, Deferred>();
  private subscribed = false;

  private ensureSubscribed(): void {
    if (this.subscribed) return;
    this.subscribed = true;
    // 进程级单订阅：捕获总线上**所有** TASK_RESULT / TASK_PROGRESS。
    a2aRouter.on("TASK_RESULT", (msg) => this.onResult(msg));
    a2aRouter.on("TASK_PROGRESS", (msg) => this.onProgress(msg));
  }

  private onResult(msg: A2AMessageEnvelope): void {
    const payload = msg.payload as TaskResultPayload | undefined;
    const taskId = payload?.taskId;
    if (!taskId) return;
    const d = this.pending.get(taskId);
    if (!d) return; // 不是本进程在等的任务
    this.pending.delete(taskId);
    if (d.timer) clearTimeout(d.timer);
    d.settled = true;
    d.settle({
      taskId,
      success: Boolean(payload?.success),
      result: payload?.result ?? null,
      errorMessage: payload?.errorMessage ?? null,
      errorCode: payload?.errorCode ?? null,
      ...(payload?.status ? { status: payload.status } : {}),
    });
  }

  private onProgress(msg: A2AMessageEnvelope): void {
    const payload = msg.payload as TaskProgressPayload | undefined;
    const taskId = payload?.taskId;
    if (!taskId) return;
    const d = this.pending.get(taskId);
    if (!d || d.settled) return;
    d.lastProgressAtMs = Date.now();
    if (d.timer) clearTimeout(d.timer);
    d.armTimer();
  }

  /**
   * 同步登记一批期望回包的 taskId，返回「全部到齐 / 超时」后 resolve 的 Promise。
   * 必须在 `a2aRouter.send` 发出对应 TASK_ASSIGN **之前**调用。
   *
   * @param opts.timeoutMs 任务墙钟（硬上限）
   * @param opts.leaseMs   通信 lease；缺省等于 timeoutMs（退化为单时钟，兼容旧调用）
   */
  expect(
    taskIds: string[],
    opts: { timeoutMs: number; leaseMs?: number }
  ): Promise<Map<string, GatheredResult>> {
    this.ensureSubscribed();
    // A task id is the correlation key. Re-registering it would overwrite the
    // first waiter; its timer could then delete the second waiter and turn a
    // real result into a false timeout. Reject the invalid lifecycle instead.
    const seen = new Set<string>();
    for (const taskId of taskIds) {
      if (!taskId.trim()) throw new Error("a2a_gather_invalid_task_id");
      if (seen.has(taskId)) throw new Error(`a2a_gather_duplicate_task_id:${taskId}`);
      if (this.pending.has(taskId)) throw new Error(`a2a_gather_task_already_pending:${taskId}`);
      seen.add(taskId);
    }
    const wallMs = Math.max(1, opts.timeoutMs);
    const leaseMs = Math.max(1, opts.leaseMs ?? wallMs);
    const results = new Map<string, GatheredResult>();
    const waits = taskIds.map(
      (taskId) =>
        new Promise<void>((resolve) => {
          const wallDeadlineMs = Date.now() + wallMs;
          const deferred: Deferred = {
            settle: (r) => {
              results.set(taskId, r);
              resolve();
            },
            timer: null,
            wallDeadlineMs,
            leaseMs,
            lastProgressAtMs: Date.now(),
            settled: false,
            armTimer: () => undefined,
          };

          const settleTimeout = (timeoutReason: "wall_clock" | "lease_expired") => {
            if (deferred.settled) return;
            deferred.settled = true;
            if (deferred.timer) clearTimeout(deferred.timer);
            deferred.timer = null;
            this.pending.delete(taskId);
            results.set(taskId, {
              taskId,
              success: false,
              result: null,
              errorMessage: "a2a_gather_timeout",
              errorCode: "a2a_gather_timeout",
              status: "timeout",
              timedOut: true,
              timeoutReason,
            });
            resolve();
          };

          deferred.armTimer = () => {
            if (deferred.settled) return;
            const now = Date.now();
            const untilWall = deferred.wallDeadlineMs - now;
            if (untilWall <= 0) {
              settleTimeout("wall_clock");
              return;
            }
            const untilLease = deferred.leaseMs - (now - deferred.lastProgressAtMs);
            if (untilLease <= 0) {
              settleTimeout("lease_expired");
              return;
            }
            const waitMs = Math.min(untilWall, untilLease);
            deferred.timer = setTimeout(() => {
              const t = Date.now();
              if (t >= deferred.wallDeadlineMs) {
                settleTimeout("wall_clock");
                return;
              }
              if (t - deferred.lastProgressAtMs >= deferred.leaseMs) {
                settleTimeout("lease_expired");
                return;
              }
              deferred.armTimer();
            }, waitMs);
            (deferred.timer as { unref?: () => void }).unref?.();
          };

          this.pending.set(taskId, deferred);
          deferred.armTimer();
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
