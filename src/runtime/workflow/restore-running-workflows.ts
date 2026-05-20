import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { normalizeLoopKind } from "../../types/loop";
import { loadLatestCheckpointSnapshot } from "../langgraph/agent-checkpoint-snapshot";
import { graphRunner } from "../langgraph/graph-factory";
import { getCheckpointSaver } from "../langgraph/sqlite-checkpoint-saver";
import { ClaudeCliLoopDriver, CodexCliLoopDriver } from "../loop/cli-loop-driver";
import { enqueueCompensationTask } from "./compensation-queue";

export type RestoreOutcome = {
  scanned: number;
  resumed: number;
  enqueuedRetry: number;
  markedFailed: number;
  cliResumed: number;
};

let _claudeDriver: ClaudeCliLoopDriver | null = null;
let _codexDriver: CodexCliLoopDriver | null = null;

function getCliDriver(kind: "claude_cli" | "codex_cli") {
  if (kind === "claude_cli") {
    if (!_claudeDriver) _claudeDriver = new ClaudeCliLoopDriver();
    return _claudeDriver;
  }
  if (!_codexDriver) _codexDriver = new CodexCliLoopDriver();
  return _codexDriver;
}

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
    cliResumed: 0,
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

      // 无 LangGraph checkpoint：先看看旁路 snapshot 是否能提供线索（仅用作运营日志），
      // 再交给补偿队列 retry_from_start。
      if (loopKind === "native") {
        const sidecar = await loadLatestCheckpointSnapshot(wf.id);
        const hint = sidecar
          ? ` last_snapshot=phase:${sidecar.phase} step:${sidecar.stepIndex} iter:${sidecar.iteration}`
          : "";
        await enqueueCompensationTask({
          workflowRunId: wf.id,
          actionType: "retry_from_start",
          reason: sidecar
            ? `process_restart_no_lg_checkpoint_but_snapshot:${sidecar.phase}@step${sidecar.stepIndex}`
            : "process_restart_no_checkpoint",
          maxRetries: 1,
        });
        outcome.enqueuedRetry += 1;
        console.log(
          `[restoreRunningWorkflows] no LG checkpoint for workflow=${wf.id}, enqueued retry_from_start${hint}`
        );
        continue;
      }

      // CLI loop（claude_cli / codex_cli）：Phase 2.5 起，若上次落了 cli_session_id 就续跑，
      // 没落就回退为标 failed 等人工介入。
      if ((loopKind === "claude_cli" || loopKind === "codex_cli") && wf.cliSessionId) {
        const driver = getCliDriver(loopKind);
        const res = await driver.resumeWorkflow({ workflowId: wf.id });
        if (res.resumed) {
          outcome.cliResumed += 1;
          console.log(
            `[restoreRunningWorkflows] cli-resumed workflow=${wf.id} ` +
              `kind=${loopKind} sessionId=${res.sessionId} runId=${res.runId}`
          );
          continue;
        }
      }

      await db
        .update(workflowRun)
        .set({
          status: "failed",
          endedAt: new Date().toISOString(),
          resumeCount: sql`${workflowRun.resumeCount} + 1`,
        })
        .where(eq(workflowRun.id, wf.id));
      outcome.markedFailed += 1;
      console.warn(
        `[restoreRunningWorkflows] CLI workflow=${wf.id} (${wf.loopKind}) no session_id; marked failed`
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
