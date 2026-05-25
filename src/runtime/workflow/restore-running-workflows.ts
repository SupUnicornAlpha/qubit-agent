import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystResearchJob, workflowHitlRequest, workflowRun } from "../../db/sqlite/schema";
import { normalizeLoopKind } from "../../types/loop";
import { loadLatestCheckpointSnapshot } from "../langgraph/agent-checkpoint-snapshot";
import { graphRunner } from "../langgraph/graph-factory";
import { getCheckpointSaver } from "../langgraph/sqlite-checkpoint-saver";
import { ClaudeCliLoopDriver, CodexCliLoopDriver } from "../loop/cli-loop-driver";
import {
  failAnalystResearchJob,
  rehydrateAnalystResearchJobsCache,
} from "../msa/analyst-research-jobs";
import { enqueueCompensationTask } from "./compensation-queue";

export type RestoreOutcome = {
  scanned: number;
  resumed: number;
  enqueuedRetry: number;
  markedFailed: number;
  cliResumed: number;
  /**
   * 从 analyst_research_job DB 回填到 in-memory cache 的 job 条数。
   * P0-2：HITL 审批 + 长跑 analyst 任务需要这条线，否则进程重启会让前端轮询
   * GET /analyst/job/:jobId 404 / resolveHitlRequest 找不到 resumePayload。
   */
  analystJobsRehydrated: number;
  /** 扫到的 awaiting_approval 工作流条数（仅记账，状态保持等用户操作） */
  awaitingApproval: number;
  /**
   * P0-3：扫到的「stale awaiting_approval」修复条数 —— hitl_request 已 approved/rejected
   * 但 analyst_research_job / workflow_run 还卡在 awaiting_approval 的死锁残留。
   * 来源：resolveHitlRequest 跑到一半 backend 崩溃。
   */
  hitlStaleRepaired: number;
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
 * 1. 有 LangGraph checkpoint 的 `running` / `pending` → 调 graphRunner.resumeRoleTask 续跑；
 * 2. 没有 checkpoint 的 → 入补偿队列 retry_from_start（或对 CLI 工作流标 failed，等用户/告警决定）；
 * 3. `awaiting_approval` → 不主动续跑（要等人审批），但要把 analyst job cache 回填，
 *    让 resolveHitlRequest 一调用就能拿到 resumePayload 重派；
 * 4. **P0-3 新增**：扫"stale awaiting_approval"——hitl_request 已 approved/rejected 但
 *    analyst job 还停在 awaiting_approval 的死锁残留（resolveHitlRequest 跑到一半崩溃），
 *    按 hitl_request.status 决策修复。
 *
 * 在 `startAllAgents()` 之后调用，确保 GraphRunner 已 ready。
 */
export async function restoreRunningWorkflows(): Promise<RestoreOutcome> {
  const db = await getDb();

  /**
   * P0-2：先回填 analyst job cache。重启后任何 GET /analyst/job/:jobId、
   * resolveHitlRequest 调用都依赖这步，必须比 candidates 处理更早做。
   */
  const analystJobsRehydrated = await rehydrateAnalystResearchJobsCache().catch((err) => {
    console.error(
      "[restoreRunningWorkflows] failed to rehydrate analyst job cache:",
      err instanceof Error ? err.message : err
    );
    return 0;
  });

  /**
   * P0-3 S5：sweep 半成品 HITL 死锁。
   *
   * resolveHitlRequest 已经包了事务，但旧版本/旧崩溃留下的 stale 行仍需修：
   *   - analyst_research_job.status='awaiting_approval'
   *   - AND 对应 workflowRunId 上没有 pending hitl_request
   *     （hitl_request 已 approved 或 rejected，或被外部清掉）
   * 对这些 job：能找到 resolved hitl_request 就按它的最终决策走（rejected→fail；
   * approved→留给后续 sweep + 重派，这里只标 fail 让用户重发起，更稳妥）；找不到就 fail。
   * 这里**只 fail**不主动续跑：用户在前端能立刻看到「失败需重发」的状态，比悄悄重派稳。
   */
  const hitlStaleRepaired = await repairStaleHitlAwaitingApproval(db).catch((err) => {
    console.error(
      "[restoreRunningWorkflows] HITL stale sweep failed:",
      err instanceof Error ? err.message : err
    );
    return 0;
  });

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
    analystJobsRehydrated,
    awaitingApproval: awaitingRows.length,
    hitlStaleRepaired,
  };
  if (analystJobsRehydrated > 0 || awaitingRows.length > 0 || hitlStaleRepaired > 0) {
    console.log(
      `[restoreRunningWorkflows] rehydrated ${analystJobsRehydrated} analyst job(s); ` +
        `${awaitingRows.length} workflow(s) in awaiting_approval (no auto-resume); ` +
        `repaired ${hitlStaleRepaired} stale HITL job(s)`
    );
  }
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

/**
 * P0-3 S5：扫 stale awaiting_approval analyst_research_job —— 对应的 hitl_request
 * 已经不是 pending（说明 resolveHitlRequest 跑到一半崩溃，状态机半成品），按最终
 * 决策修复。
 *
 * 保守策略：发现 stale 就 fail 这个 analyst job + 把 workflow_run 标 failed。
 * 不主动 resume 让 analyst 继续跑 —— 因为用户已经看不到原 HITL banner 了，没法再
 * 选择，再跑可能违背用户原意（比如审批时勾的 options 没透传过来）；告诉用户
 * "请重发起" 比悄悄重跑稳。
 */
async function repairStaleHitlAwaitingApproval(
  db: Awaited<ReturnType<typeof getDb>>
): Promise<number> {
  const staleJobs = await db
    .select({
      jobId: analystResearchJob.id,
      workflowRunId: analystResearchJob.workflowRunId,
      hitlRequestId: analystResearchJob.hitlRequestId,
    })
    .from(analystResearchJob)
    .where(eq(analystResearchJob.status, "awaiting_approval"));
  if (staleJobs.length === 0) return 0;

  let repaired = 0;
  for (const job of staleJobs) {
    try {
      const pendingHitl = await db
        .select({ id: workflowHitlRequest.id })
        .from(workflowHitlRequest)
        .where(
          and(
            eq(workflowHitlRequest.workflowRunId, job.workflowRunId),
            eq(workflowHitlRequest.status, "pending")
          )
        )
        .limit(1);
      if (pendingHitl.length > 0) continue;

      const reason =
        "stale HITL state detected on boot (resolveHitlRequest interrupted before commit?); please re-run";
      await failAnalystResearchJob(job.jobId, new Error(reason));
      await db
        .update(workflowRun)
        .set({
          status: "failed",
          endedAt: new Date().toISOString(),
        })
        .where(
          and(
            eq(workflowRun.id, job.workflowRunId),
            inArray(workflowRun.status, ["awaiting_approval", "running", "pending"])
          )
        );
      repaired += 1;
      console.warn(
        `[restoreRunningWorkflows] repaired stale HITL analyst job=${job.jobId} workflow=${job.workflowRunId}`
      );
    } catch (err) {
      console.error(
        `[restoreRunningWorkflows] failed to repair stale job=${job.jobId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return repaired;
}
