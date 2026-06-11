import { a2aLoopDriver } from "../a2a/a2a-loop-driver";
import type { DispatchToLoopParams, LoopDriver } from "./loop-driver";

/**
 * native loop 的派发已收敛到 A2A 总线（graph 派发删除后）。
 * 这里保留 NativeLoopDriver 作为 LoopDriver 注册项，直接委托给 a2aLoopDriver。
 * 实际上 dispatchTaskToRole 对 native 已直接走 a2aLoopDriver，此 driver 仅作兜底。
 */
export class NativeLoopDriver implements LoopDriver {
  readonly kind = "native" as const;

  async dispatchTask(params: DispatchToLoopParams): Promise<{ runId: string }> {
    return a2aLoopDriver.dispatchTask(params);
  }
}

export const nativeLoopDriver = new NativeLoopDriver();
