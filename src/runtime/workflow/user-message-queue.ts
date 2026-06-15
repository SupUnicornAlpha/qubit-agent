/**
 * 运行中「随时插话」消息队列 —— 让用户在 ReAct 循环跑动时给 Orchestrator/agent 追加指令。
 *
 * 入队：POST /api/v1/workflows/:id/inject-message → enqueueUserMessage
 * 出队：run-react-loop.ts 每轮 reason 前调 drainUserMessages，把 queued 消息取走并注入
 *       LLM 上下文（标记 injected）。软注入，不阻塞工作流；与 HITL 硬暂停互补。
 *
 * 设计取舍：
 *  - 用 status=queued→injected 的乐观取走（先 SELECT 后 UPDATE），单进程 agent-pool
 *    下无并发取走风险；多副本场景再加 SELECT ... FOR UPDATE / 乐观锁。
 *  - targetRole 为空 = 任意 agent 可消费；非空 = 仅该 role drain（典型只发给 orchestrator）。
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { userMessageQueue } from "../../db/sqlite/schema";

export interface EnqueueUserMessageInput {
  workflowRunId: string;
  content: string;
  /** 目标角色；省略 = 任意 agent 可消费 */
  targetRole?: string | null;
}

/** 把一条用户消息写入队列（status=queued）。返回新建行 id。 */
export async function enqueueUserMessage(input: EnqueueUserMessageInput): Promise<string> {
  const content = input.content.trim();
  if (!content) throw new Error("inject message content is empty");
  const db = await getDb();
  const id = randomUUID();
  await db.insert(userMessageQueue).values({
    id,
    workflowRunId: input.workflowRunId,
    targetRole: input.targetRole ?? null,
    content,
    status: "queued",
  });
  return id;
}

/** 当前工作流是否还有未消费（queued）的注入消息——前端可据此提示「已排队，下一轮生效」。 */
export async function countQueuedUserMessages(workflowRunId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: userMessageQueue.id })
    .from(userMessageQueue)
    .where(
      and(eq(userMessageQueue.workflowRunId, workflowRunId), eq(userMessageQueue.status, "queued"))
    );
  return rows.length;
}

/**
 * Drain 本工作流中「角色可见」的 queued 消息：取出按时间升序的全部内容，标记 injected。
 *
 * 角色可见 = targetRole 为空（广播）或 targetRole === role。
 * 取空时返回 []（调用方据此跳过注入，零开销）。
 */
export async function drainUserMessages(workflowRunId: string, role: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(userMessageQueue)
    .where(
      and(
        eq(userMessageQueue.workflowRunId, workflowRunId),
        eq(userMessageQueue.status, "queued"),
        or(isNull(userMessageQueue.targetRole), eq(userMessageQueue.targetRole, role))
      )
    )
    .orderBy(asc(userMessageQueue.createdAt));

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  await db
    .update(userMessageQueue)
    .set({ status: "injected", injectedAt: new Date().toISOString() })
    .where(inArray(userMessageQueue.id, ids));

  return rows.map((r) => r.content);
}
