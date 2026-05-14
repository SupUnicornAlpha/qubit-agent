/**
 * 研究团队异步任务（与 POST /analyst/run 轮询共用）。
 * 任务完成由 Orchestrator 图内 research_team_execute 短路写入，避免循环依赖。
 */

import type { AnalystTeamResult } from "./analyst-team";

export interface AnalystResearchJob {
  status: "running" | "completed" | "failed";
  result?: AnalystTeamResult;
  error?: string;
  workflowRunId: string;
  ticker: string;
  startedAt: number;
  endedAt?: number;
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
