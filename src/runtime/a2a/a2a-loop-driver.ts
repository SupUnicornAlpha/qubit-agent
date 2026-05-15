import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { a2aRouter } from "../../messaging/a2a";
import type { DispatchToLoopParams, LoopDriver } from "../loop/loop-driver";
import { getA2APool } from "./a2a-pool";

export class A2ALoopDriver implements LoopDriver {
  readonly kind = "native" as const;

  async dispatchTask(params: DispatchToLoopParams): Promise<{ runId: string }> {
    const pool = getA2APool();
    if (!pool.hasRole(params.role)) {
      throw new Error(`A2A pool missing runtime for role=${params.role}`);
    }

    const receiverId = pool.getInstanceIdForRole(params.role);
    const traceId = params.traceId ?? randomUUID();
    const runId = randomUUID();

    let senderId: string;
    try {
      senderId = pool.getInstanceIdForRole("orchestrator");
    } catch {
      senderId = receiverId;
    }

    await a2aRouter.send({
      workflowId: params.workflowId,
      traceId,
      senderAgent: senderId,
      receiverAgent: receiverId,
      messageType: "TASK_ASSIGN",
      payload: params.payload,
      priority: 50,
    });

    const db = await getDb();
    await db
      .update(workflowRun)
      .set({ status: "running" })
      .where(eq(workflowRun.id, params.workflowId));

    return { runId };
  }
}

export const a2aLoopDriver = new A2ALoopDriver();
