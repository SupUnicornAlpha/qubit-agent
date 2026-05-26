import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";
import { setWorkflowState } from "../workflow/workflow-state-machine";

export const TRADER_WORKFLOW_GOAL = "QUBIT 实时交易 Agent 执行上下文";

export const TRADER_LOOP_OPTIONS = { kind: "trader_context" } as const;

export function isTraderWorkflowGoal(goal: string): boolean {
  return /QUBIT 实时交易|实时交易 Agent 执行上下文/i.test(goal.trim());
}

function isTraderLoopOptions(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  return (raw as { kind?: string }).kind === "trader_context";
}

export function isTraderWorkflowRow(row: {
  goal: string;
  loopOptionsJson?: unknown;
}): boolean {
  return isTraderWorkflowGoal(row.goal) || isTraderLoopOptions(row.loopOptionsJson);
}

/** 软取消实时交易专用 workflow（保留审计与历史 order_intent） */
export async function cancelTraderWorkflows(
  db: DbClient,
  filter?: { sessionId?: string; projectId?: string }
): Promise<string[]> {
  const rows = await db.select().from(workflowRun).orderBy(desc(workflowRun.startedAt));
  const ids: string[] = [];

  for (const row of rows) {
    if (row.status === "cancelled") continue;
    if (!isTraderWorkflowRow(row)) continue;
    if (filter?.sessionId && row.sessionId !== filter.sessionId) continue;
    if (filter?.projectId && row.projectId !== filter.projectId) continue;
    await setWorkflowState(row.id, "cancelled", { reason: "trader:cancel" });
    ids.push(row.id);
  }
  return ids;
}

/**
 * 每个 (projectId, sessionId) 仅保留一条未取消的实时交易 workflow。
 * 多余的标记为 cancelled。
 */
export async function consolidateTraderWorkflowsForSession(
  db: DbClient,
  input: { projectId: string; sessionId: string }
): Promise<string | null> {
  const rows = await db
    .select()
    .from(workflowRun)
    .where(
      and(eq(workflowRun.projectId, input.projectId), eq(workflowRun.sessionId, input.sessionId))
    )
    .orderBy(desc(workflowRun.startedAt));

  const traderRows = rows.filter((r) => isTraderWorkflowRow(r));
  const active = traderRows.filter((r) => r.status !== "cancelled");
  if (active.length === 0) return null;

  const keep = active[0]!;
  const dupIds = active.slice(1).map((r) => r.id);
  for (const dupId of dupIds) {
    await setWorkflowState(dupId, "cancelled", { reason: "trader:consolidate-dup" });
  }

  /**
   * P1-A：保留多字段直写（goal/mode/loopKind/...），但 status 单独经状态机：
   * 既能跟踪迁移又能保留批量字段更新性能。
   */
  await db
    .update(workflowRun)
    .set({
      goal: TRADER_WORKFLOW_GOAL,
      mode: "simulation",
      source: "api",
      loopKind: "native",
      executionPath: "graph",
      loopOptionsJson: TRADER_LOOP_OPTIONS,
    })
    .where(eq(workflowRun.id, keep.id));
  await setWorkflowState(keep.id, "running", { reason: "trader:consolidate-keep" });

  return keep.id;
}

/** 启动时一次性取消全部历史实时交易 workflow（由标记文件控制） */
export async function purgeAllTraderWorkflowsOnce(): Promise<number> {
  const { existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { config } = await import("../../config");
  const flag = join(config.dataDir, ".trader-workflow-purged-v1");
  if (existsSync(flag)) return 0;

  const db = await getDb();
  const cancelled = await cancelTraderWorkflows(db);
  writeFileSync(flag, `${new Date().toISOString()}\n${cancelled.length} workflows cancelled\n`, "utf8");
  if (cancelled.length > 0) {
    console.log(`[QUBIT] Purged ${cancelled.length} legacy trader workflow(s).`);
  }
  return cancelled.length;
}

export async function getOrCreateTraderWorkflow(input: {
  projectId: string;
  sessionId: string;
}): Promise<{ workflowRunId: string; created: boolean }> {
  const db = await getDb();
  const existingId = await consolidateTraderWorkflowsForSession(db, input);
  if (existingId) {
    return { workflowRunId: existingId, created: false };
  }

  const created = await createAndDispatchWorkflow({
    projectId: input.projectId,
    goal: TRADER_WORKFLOW_GOAL,
    mode: "simulation",
    sessionId: input.sessionId,
    source: "api",
    skipDispatch: true,
    reuseSessionWorkflow: false,
    loopOptionsJson: TRADER_LOOP_OPTIONS,
  });

  await db
    .update(workflowRun)
    .set({
      loopOptionsJson: TRADER_LOOP_OPTIONS,
    })
    .where(eq(workflowRun.id, created.data.id));
  await setWorkflowState(created.data.id, "running", { reason: "trader:create" });

  return { workflowRunId: created.data.id, created: true };
}
