import { graphRunner } from "../langgraph/graph-factory";
import type { DispatchToLoopParams, LoopDriver } from "./loop-driver";

export class NativeLoopDriver implements LoopDriver {
  readonly kind = "native" as const;

  async dispatchTask(params: DispatchToLoopParams): Promise<{ runId: string }> {
    return graphRunner.runRoleTask({
      workflowId: params.workflowId,
      role: params.role,
      payload: params.payload,
      traceId: params.traceId,
    });
  }
}

export const nativeLoopDriver = new NativeLoopDriver();
