import { randomUUID } from "node:crypto";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { normalizeLoopKind } from "../../types/loop";
import { dispatchTaskToRole } from "../agent-pool";
import { loadLatestCheckpointSnapshot } from "../host/checkpoint-snapshot";
import { ClaudeCliLoopDriver, CodexCliLoopDriver } from "../loop/cli-loop-driver";
import { enqueueCompensationTask, processCompensationQueue } from "./compensation-queue";
import { setWorkflowState } from "./workflow-state-machine";

export type RestoreOutcome = {
  scanned: number;
  resumed: number;
  enqueuedRetry: number;
  markedFailed: number;
  cliResumed: number;
  compensationProcessed: number;
  /** 扫到的 awaiting_approval 工作流条数（仅记账，状态保持等用户操作） */
  awaitingApproval: number;
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
 * 1. 有 Host snapshot 线索的 `running` / `pending` native 工作流 → 派 A2A workflow_resume
 *    给 orchestrator；**推理由 Rust Core 续跑**（Phase B：不再 restore TS AgentGraphState）；
 * 2. 没有 snapshot 的 → 入补偿队列 retry_from_start（或对 CLI 工作流标 failed）；
 * 3. `awaiting_approval` → 不主动续跑，等待对话 HITL 操作。
 *
 * 在 `startAllAgents()` 之后调用，确保 A2APool 已 ready。
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

  /**
   * 仅记账，不动状态：awaiting_approval 的工作流等用户操作，
   * 这里查一下数量便于启动日志可观测。
   */
  const awaitingRows = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(eq(workflowRun.status, "awaiting_approval"));

  const outcome: RestoreOutcome = {
    scanned: candidates.length,
    resumed: 0,
    enqueuedRetry: 0,
    markedFailed: 0,
    cliResumed: 0,
    compensationProcessed: 0,
    awaitingApproval: awaitingRows.length,
  };
  if (awaitingRows.length > 0) {
    console.log(
      `[restoreRunningWorkflows] ${awaitingRows.length} workflow(s) in awaiting_approval (no auto-resume)`
    );
  }
  if (candidates.length === 0) return outcome;

  for (const wf of candidates) {
    const loopKind = normalizeLoopKind(wf.loopKind);
    try {
      // native：有 Host snapshot 线索则派 workflow_resume → Rust Core（不再还原 TS ReAct 状态）。
      if (loopKind === "native") {
        const snapshot = await loadLatestCheckpointSnapshot(wf.id);
        if (snapshot) {
          await dispatchTaskToRole({
            workflowId: wf.id,
            role: "orchestrator",
            payload: {
              taskId: randomUUID(),
              taskType: "workflow_resume",
              assignedRole: "orchestrator",
              params: { workflowRunId: wf.id, goal: wf.goal, mode: wf.mode, resume: true },
            },
          });
          outcome.resumed += 1;
          console.log(
            `[restoreRunningWorkflows] resumed workflow=${wf.id} via Core ` +
              `(legacy host snapshot phase:${snapshot.phase} step:${snapshot.stepIndex})`
          );
          continue;
        }

        // 无 snapshot：交给补偿队列 retry_from_start。
        await enqueueCompensationTask({
          workflowRunId: wf.id,
          actionType: "retry_from_start",
          reason: "process_restart_no_snapshot",
          maxRetries: 3,
        });
        await setWorkflowState(wf.id, "pending", { reason: "restore:no_snapshot_compensation" });
        outcome.enqueuedRetry += 1;
        console.log(
          `[restoreRunningWorkflows] no snapshot for workflow=${wf.id}, enqueued retry_from_start`
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

  if (outcome.enqueuedRetry > 0) {
    try {
      const processed = await processCompensationQueue(Math.max(10, outcome.enqueuedRetry));
      outcome.compensationProcessed = processed.picked;
      if (processed.picked > 0) {
        console.log(
          `[restoreRunningWorkflows] processed ${processed.picked} compensation task(s): ` +
            `success=${processed.success} failed=${processed.failed}`
        );
      }
    } catch (err) {
      console.error(
        "[restoreRunningWorkflows] compensation queue processing failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  return outcome;
}
