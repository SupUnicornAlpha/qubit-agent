import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { getExperienceBus } from "../experience";
import { consolidateFromWorkflow } from "../memory/memory-consolidation";
import { syncMemoryForWorkflow } from "../memory/memory-workspace-sync";
import { createAlertsFromWorkflowQuality } from "./alert-service";
import { createWorkflowQualitySnapshot } from "./quality-metrics";

export type WorkflowTerminalStatus = "completed" | "failed";

/**
 * Fire-and-forget hook when a workflow reaches a terminal state.
 * Writes a quality snapshot, evaluates alert rules, and (M10.A1) consolidates
 * session-level work into midterm memory — all without blocking the caller.
 *
 * Memory V2 P1：把 workflow_terminal 事件抛上 ExperienceBus，让
 * Writer / Extractor / Reflector 这 3 个 pipe 各自决定要不要响应；旧的
 * `consolidateFromWorkflow` 继续跑（双写期），下线时机见 §7.4 对账方案。
 */
export function onWorkflowTerminal(workflowId: string, status: WorkflowTerminalStatus): void {
  void (async () => {
    try {
      const snapshot = await createWorkflowQualitySnapshot(workflowId);
      await createAlertsFromWorkflowQuality(workflowId, { status, snapshot });
    } catch (err) {
      console.warn(
        `[observability] terminal hook failed for workflow ${workflowId}:`,
        err instanceof Error ? err.message : err
      );
    }

    // M10.A1 + A2: only consolidate for *completed* workflows
    if (status === "completed") {
      try {
        const result = await consolidateFromWorkflow(workflowId);
        if (result.status === "completed" && result.midtermInserted > 0) {
          console.log(
            `[memory] consolidated workflow ${workflowId} → ${result.midtermInserted} midterm records`
          );
          // A2: 同步参与的 agent 的 memory.md 让 Agent 下次启动能拿到上次的长期记忆
          const synced = await syncMemoryForWorkflow(workflowId);
          if (synced > 0) {
            console.log(`[memory] synced memory.md for ${synced} agents`);
          }
        }
      } catch (err) {
        console.warn(
          `[memory] consolidation failed for workflow ${workflowId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Memory V2 P1: 触发新管道（与旧路径并行）
    try {
      const projectId = await loadWorkflowProjectId(workflowId);
      if (projectId) {
        getExperienceBus().emit({
          type: "workflow_terminal",
          workflowRunId: workflowId,
          projectId,
          status,
        });
      }
    } catch (err) {
      console.warn(
        `[experience] terminal emit failed for workflow ${workflowId}:`,
        err instanceof Error ? err.message : err
      );
    }
  })();
}

async function loadWorkflowProjectId(workflowId: string): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .select({ projectId: workflowRun.projectId })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowId))
    .limit(1);
  return rows[0]?.projectId ?? null;
}
