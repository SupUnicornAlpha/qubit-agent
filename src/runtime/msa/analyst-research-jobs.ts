/**
 * 研究团队异步任务（与 POST /analyst/run 轮询共用）。
 *
 * 任务完成由 Orchestrator 图内 research_team_execute 短路写入，避免循环依赖。
 *
 * HITL 暂停语义：
 * - Orchestrator 规划完成后若命中 team HITL，会抛 `HitlAwaitingApprovalError`，
 *   `pauseAnalystResearchJob` 把 job 标 `awaiting_approval` 并记录 `hitlRequestId`，
 *   前端轮询能拿到 requestId / title / summary 渲染审批卡片；
 * - 审批通过后 `resolveHitlRequest` 调 `resumeAnalystResearchJob`，把 job 恢复 running
 *   并重派 research_team_execute（带 hitlApproval）让本次分析继续跑到底。
 */

import type { ParsedResearchTeamExecute } from "./research-team-execute";
import type { AnalystTeamResult } from "./analyst-team";

export type AnalystResearchJobStatus = "running" | "completed" | "failed" | "awaiting_approval";

export interface AnalystResearchJob {
  status: AnalystResearchJobStatus;
  result?: AnalystTeamResult;
  error?: string;
  workflowRunId: string;
  ticker: string;
  startedAt: number;
  endedAt?: number;
  /** awaiting_approval 时挂上的 HITL 请求 ID（resolved 后清空） */
  hitlRequestId?: string;
  hitlTitle?: string;
  hitlSummary?: string;
  /** 缓存原 research_team_execute params，便于批准后重派 */
  resumePayload?: ParsedResearchTeamExecute;
}

const jobs = new Map<string, AnalystResearchJob>();

export function registerAnalystResearchJob(jobId: string, job: AnalystResearchJob): void {
  jobs.set(jobId, job);
}

export function getAnalystResearchJob(jobId: string): AnalystResearchJob | undefined {
  return jobs.get(jobId);
}

export function completeAnalystResearchJob(jobId: string, result: AnalystTeamResult): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "completed";
  job.result = result;
  job.endedAt = Date.now();
  delete job.hitlRequestId;
  delete job.hitlTitle;
  delete job.hitlSummary;
  console.log(`[AnalystResearchJobs] job ${jobId} completed in ${job.endedAt - job.startedAt}ms`);
}

export function failAnalystResearchJob(jobId: string, err: unknown): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "failed";
  job.error = err instanceof Error ? err.message : String(err);
  job.endedAt = Date.now();
  console.error(`[AnalystResearchJobs] job ${jobId} failed:`, err);
}

export function pauseAnalystResearchJobForHitl(
  jobId: string,
  input: {
    requestId: string;
    title: string;
    summary: string;
    resumePayload?: ParsedResearchTeamExecute;
  }
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "awaiting_approval";
  job.hitlRequestId = input.requestId;
  job.hitlTitle = input.title;
  job.hitlSummary = input.summary;
  if (input.resumePayload) {
    job.resumePayload = input.resumePayload;
  }
  console.log(
    `[AnalystResearchJobs] job ${jobId} paused for HITL request=${input.requestId}`
  );
}

export function resumeAnalystResearchJob(jobId: string): ParsedResearchTeamExecute | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (job.status === "awaiting_approval") {
    job.status = "running";
    delete job.hitlRequestId;
    delete job.hitlTitle;
    delete job.hitlSummary;
    console.log(`[AnalystResearchJobs] job ${jobId} resumed`);
  }
  return job.resumePayload;
}

/** 通过 workflowRunId 反查最近一个 awaiting_approval 的 job（resolveHitlRequest 需要） */
export function findPendingAnalystJobByWorkflow(workflowRunId: string):
  | { jobId: string; job: AnalystResearchJob }
  | undefined {
  for (const [jobId, job] of jobs.entries()) {
    if (job.workflowRunId === workflowRunId && job.status === "awaiting_approval") {
      return { jobId, job };
    }
  }
  return undefined;
}
