import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { isBenchmarkWorkflow } from "../benchmark/benchmark-namespace";
import { getExperienceBus } from "../experience";
import { consolidateSkillsFromWorkflow } from "../memory/workflow-skill-consolidation";
import { syncMemoryForWorkflow } from "../memory/memory-workspace-sync";
import { createAlertsFromWorkflowQuality } from "./alert-service";
import { createWorkflowQualitySnapshot } from "./quality-metrics";

export type WorkflowTerminalStatus = "completed" | "partial" | "failed";

/**
 * Fire-and-forget hook when a workflow reaches a terminal state.
 * Writes quality snapshot, alerts, skill candidates, Experience Bus emit.
 */
export function onWorkflowTerminal(workflowId: string, status: WorkflowTerminalStatus): void {
  void (async () => {
    try {
      if (await isBenchmarkWorkflow(workflowId)) return;
      const snapshot = await createWorkflowQualitySnapshot(workflowId);
      await createAlertsFromWorkflowQuality(workflowId, {
        status,
        ...(snapshot ? { snapshot } : {}),
      });
      const { persistWorkflowEvalScores } = await import("../eval-platform/orchestrator");
      await persistWorkflowEvalScores({ workflowRunId: workflowId });
      const { enqueueAsyncEval } = await import("../eval-platform/async-eval/queue");
      enqueueAsyncEval(workflowId);
    } catch (err) {
      console.warn(
        `[observability] terminal hook failed for workflow ${workflowId}:`,
        err instanceof Error ? err.message : err
      );
    }

    if (status === "completed") {
      try {
        const result = await consolidateSkillsFromWorkflow(workflowId);
        if (result.status === "completed" && result.skillCandidatesProposed > 0) {
          console.log(
            `[memory] workflow ${workflowId} → ${result.skillCandidatesProposed} skill candidate(s)`
          );
        }
        const synced = await syncMemoryForWorkflow(workflowId);
        if (synced > 0) {
          console.log(`[memory] synced memory.md for ${synced} agents`);
        }
      } catch (err) {
        console.warn(
          `[memory] skill consolidation failed for workflow ${workflowId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }

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
