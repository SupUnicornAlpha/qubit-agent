import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { graphRunner } from "../langgraph/graph-factory";
import { getCheckpointSaver } from "../langgraph/sqlite-checkpoint-saver";
import { normalizeLoopKind } from "../../types/loop";
import { enqueueCompensationTask } from "./compensation-queue";

export type RestoreOutcome = {
  scanned: number;
  resumed: number;
  enqueuedRetry: number;
  markedFailed: number;
};

/**
 * 进程启动时扫描"未结束"工作流：
 * 1. 有 LangGraph checkpoint 的 → 调 graphRunner.resumeRoleTask 续跑；
 * 2. 没有 checkpoint 的 → 入补偿队列 retry_from_start（或对 CLI 工作流标 failed，等用户/告警决定）；
 *
 * 在 `startAllAgents()` 之后调用，确保 GraphRunner 已 ready。
 */
export async function restoreRunningWorkflows(): Promise<RestoreOutcome> {
  const db = await getDb();
  const candidates = await db
    .select()
    .from(workflowRun)
    .where(
      and(
        or(eq(workflowRun.status, "running"), eq(workflowRun.status, "pending")),
        isNull(workflowRun.endedAt)
      )
    );

  const outcome: RestoreOutcome = {
    scanned: candidates.length,
    resumed: 0,
    enqueuedRetry: 0,
    markedFailed: 0,
  };
  if (candidates.length === 0) return outcome;

  const saver = getCheckpointSaver();

  for (const wf of candidates) {
    const loopKind = normalizeLoopKind(wf.loopKind);
    try {
      const tuple = await saver.getTuple({ configurable: { thread_id: wf.id } });
      if (tuple && loopKind === "native") {
        await graphRunner.resumeRoleTask({ workflowId: wf.id });
        outcome.resumed += 1;
        console.log(
          `[restoreRunningWorkflows] resumed workflow=${wf.id} from checkpoint=${tuple.checkpoint.id}`
        );
        continue;
      }

      // 无 checkpoint：交给补偿队列，依赖原 orchestrator 重跑
      if (loopKind === "native") {
        await enqueueCompensationTask({
          workflowRunId: wf.id,
          actionType: "retry_from_start",
          reason: "process_restart_no_checkpoint",
          maxRetries: 1,
        });
        outcome.enqueuedRetry += 1;
        console.log(
          `[restoreRunningWorkflows] no checkpoint for workflow=${wf.id}, enqueued retry_from_start`
        );
        continue;
      }

      // CLI loop（claude_cli / codex_cli）目前没有跨进程恢复能力 → 直接标 failed，
      // 由 Phase 2.5 引入 --resume 后再升级为真续跑。
      await db
        .update(workflowRun)
        .set({
          status: "failed",
          endedAt: new Date().toISOString(),
        })
        .where(eq(workflowRun.id, wf.id));
      // 同步标记累计字段，便于运营查询此次重启造成的中断
      await db
        .update(workflowRun)
        .set({ resumeCount: sql`${workflowRun.resumeCount} + 1` })
        .where(eq(workflowRun.id, wf.id));
      outcome.markedFailed += 1;
      console.warn(
        `[restoreRunningWorkflows] CLI workflow=${wf.id} (${wf.loopKind}) marked failed; manual rerun required`
      );
    } catch (error) {
      console.error(
        `[restoreRunningWorkflows] failed to handle workflow=${wf.id}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  return outcome;
}
