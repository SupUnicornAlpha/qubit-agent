import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import type { LoopOptionsJson } from "../../types/loop";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { setWorkflowState } from "../workflow/workflow-state-machine";

export const CHAT_SESSION_WORKFLOW_SOURCE = "chat" as const;

/**
 * 每个 chat session 仅保留一条 source=chat 的工作流（最早创建者为 canonical）。
 * 历史重复项标记为 cancelled，避免同一会话多 workflow 串台。
 */
export async function consolidateChatWorkflowsForSession(
  db: DbClient,
  input: { projectId: string; sessionId: string }
): Promise<string | null> {
  const rows = await db
    .select()
    .from(workflowRun)
    .where(
      and(
        eq(workflowRun.projectId, input.projectId),
        eq(workflowRun.sessionId, input.sessionId),
        eq(workflowRun.source, CHAT_SESSION_WORKFLOW_SOURCE)
      )
    )
    .orderBy(asc(workflowRun.startedAt));

  if (rows.length === 0) return null;

  const keep = rows[0]!;
  for (const dup of rows.slice(1)) {
    if (dup.status !== "cancelled") {
      await setWorkflowState(dup.id, "cancelled", { reason: "session-workflow:consolidate-dup" });
    }
  }
  return keep.id;
}

export async function getCanonicalChatSessionWorkflowId(input: {
  projectId: string;
  sessionId: string;
}): Promise<string | null> {
  const db = await getDb();
  return consolidateChatWorkflowsForSession(db, input);
}

/**
 * 保证 session 有且仅有一条 chat workflow；不存在则创建占位（skipDispatch）。
 */
export async function ensureChatSessionWorkflow(input: {
  projectId: string;
  sessionId: string;
  goal?: string;
  mode?: "research" | "backtest" | "simulation" | "live";
  loopOptionsJson?: LoopOptionsJson;
}): Promise<{ workflowRunId: string; created: boolean }> {
  const db = await getDb();
  const existingId = await consolidateChatWorkflowsForSession(db, input);
  if (existingId) {
    return { workflowRunId: existingId, created: false };
  }

  const created = await createAndDispatchWorkflow({
    projectId: input.projectId,
    sessionId: input.sessionId,
    goal: input.goal?.trim() || "新会话",
    mode: input.mode ?? "research",
    source: CHAT_SESSION_WORKFLOW_SOURCE,
    skipDispatch: true,
    reuseSessionWorkflow: true,
    ...(input.loopOptionsJson ? { loopOptionsJson: input.loopOptionsJson } : {}),
  });

  return { workflowRunId: created.data.id, created: true };
}

/** 启动/维护任务：扫描全部 session，合并重复的 chat workflow。幂等。 */
export async function consolidateAllChatSessionWorkflows(): Promise<{
  sessionsScanned: number;
  duplicatesCancelled: number;
}> {
  const db = await getDb();
  const rows = await db
    .select({
      projectId: workflowRun.projectId,
      sessionId: workflowRun.sessionId,
    })
    .from(workflowRun)
    .where(
      and(eq(workflowRun.source, CHAT_SESSION_WORKFLOW_SOURCE), isNotNull(workflowRun.sessionId))
    );

  const seen = new Set<string>();
  let duplicatesCancelled = 0;

  for (const row of rows) {
    if (!row.sessionId) continue;
    const key = `${row.projectId}:${row.sessionId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const before = await db
      .select({ id: workflowRun.id, status: workflowRun.status })
      .from(workflowRun)
      .where(
        and(
          eq(workflowRun.projectId, row.projectId),
          eq(workflowRun.sessionId, row.sessionId),
          eq(workflowRun.source, CHAT_SESSION_WORKFLOW_SOURCE)
        )
      );
    await consolidateChatWorkflowsForSession(db, {
      projectId: row.projectId,
      sessionId: row.sessionId,
    });
    duplicatesCancelled += Math.max(0, before.filter((r) => r.status !== "cancelled").length - 1);
  }

  return { sessionsScanned: seen.size, duplicatesCancelled };
}
