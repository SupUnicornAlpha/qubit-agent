/**
 * 研究团队异步任务（与 POST /analyst/run 轮询共用）。
 *
 * **P0-2 后语义**：DB（`analyst_research_job` 表）是真相源，进程内 Map 仅作热路径 cache。
 *
 * 所有 register / complete / fail / pause / resume 都先 upsert DB 再更新 cache，read API
 * cache miss 时回查 DB 并填回。这样：
 *   - 进程重启 + restoreRunningWorkflows 还没扫到 → 前端 GET /job/:jobId 仍能从 DB 取到
 *     最新状态，不再 404 / "resumePayload 丢了" 401；
 *   - HITL 审批中遇到 backend 重启 → resolveHitlRequest 依旧能 dispatch 续跑；
 *   - 工作流 cancel/hard-delete 也能从 DB 找到所有还活着的 job 并打断。
 *
 * HITL 暂停语义不变：
 * - Orchestrator 规划完命中 team HITL → 抛 `HitlAwaitingApprovalError`，
 *   `pauseAnalystResearchJobForHitl` 把 job 标 `awaiting_approval` 并存 `hitlRequestId` /
 *   `resumePayload`（DB），前端轮询拿到 requestId/title/summary 渲染审批卡片；
 * - 审批通过后 `resolveHitlRequest` 调 `resumeAnalystResearchJob` 取回 `resumePayload`，
 *   把 job 恢复 running 并重派 `research_team_execute`（带 hitlApproval）。
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { analystResearchJob } from "../../db/sqlite/schema";
import type { AnalystTeamResult } from "./analyst-team";
import type { ParsedResearchTeamExecute } from "./research-team-execute";

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

interface AnalystResearchJobRow {
  id: string;
  workflowRunId: string;
  status: AnalystResearchJobStatus;
  ticker: string;
  resumePayloadJson: unknown;
  resultJson: unknown;
  errorMessage: string | null;
  hitlRequestId: string | null;
  hitlTitle: string | null;
  hitlSummary: string | null;
  startedAt: string;
  endedAt: string | null;
  updatedAt: string;
}

// ─── In-memory cache（热路径加速） ───────────────────────────────────────────

const cache = new Map<string, AnalystResearchJob>();

function nowIso(): string {
  return new Date().toISOString();
}

function rowToJob(row: AnalystResearchJobRow): AnalystResearchJob {
  const job: AnalystResearchJob = {
    status: row.status,
    workflowRunId: row.workflowRunId,
    ticker: row.ticker,
    startedAt: Date.parse(row.startedAt),
  };
  if (row.endedAt) {
    job.endedAt = Date.parse(row.endedAt);
  }
  if (row.errorMessage) {
    job.error = row.errorMessage;
  }
  if (row.hitlRequestId) {
    job.hitlRequestId = row.hitlRequestId;
  }
  if (row.hitlTitle) {
    job.hitlTitle = row.hitlTitle;
  }
  if (row.hitlSummary) {
    job.hitlSummary = row.hitlSummary;
  }
  if (row.resultJson) {
    job.result = row.resultJson as AnalystTeamResult;
  }
  if (row.resumePayloadJson) {
    job.resumePayload = row.resumePayloadJson as ParsedResearchTeamExecute;
  }
  return job;
}

// ─── 写操作（DB 先写，cache 后更新） ─────────────────────────────────────────

export async function registerAnalystResearchJob(
  jobId: string,
  job: AnalystResearchJob
): Promise<void> {
  const db = await getDb();
  const startedIso = new Date(job.startedAt).toISOString();
  await db
    .insert(analystResearchJob)
    .values({
      id: jobId,
      workflowRunId: job.workflowRunId,
      status: job.status,
      ticker: job.ticker,
      startedAt: startedIso,
      updatedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: analystResearchJob.id,
      set: {
        workflowRunId: job.workflowRunId,
        status: job.status,
        ticker: job.ticker,
        startedAt: startedIso,
        updatedAt: nowIso(),
      },
    });
  cache.set(jobId, { ...job });
}

export async function completeAnalystResearchJob(
  jobId: string,
  result: AnalystTeamResult
): Promise<void> {
  const db = await getDb();
  const endedIso = nowIso();
  await db
    .update(analystResearchJob)
    .set({
      status: "completed",
      resultJson: result as never,
      hitlRequestId: null,
      hitlTitle: null,
      hitlSummary: null,
      endedAt: endedIso,
      updatedAt: endedIso,
    })
    .where(eq(analystResearchJob.id, jobId));

  const job = cache.get(jobId);
  if (job) {
    job.status = "completed";
    job.result = result;
    job.endedAt = Date.parse(endedIso);
    delete job.hitlRequestId;
    delete job.hitlTitle;
    delete job.hitlSummary;
    console.log(`[AnalystResearchJobs] job ${jobId} completed in ${job.endedAt - job.startedAt}ms`);
  } else {
    console.log(`[AnalystResearchJobs] job ${jobId} completed (cache cold, DB-only)`);
  }
}

export async function failAnalystResearchJob(jobId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const db = await getDb();
  const endedIso = nowIso();
  await db
    .update(analystResearchJob)
    .set({
      status: "failed",
      errorMessage: msg,
      endedAt: endedIso,
      updatedAt: endedIso,
    })
    .where(eq(analystResearchJob.id, jobId));

  const job = cache.get(jobId);
  if (job) {
    job.status = "failed";
    job.error = msg;
    job.endedAt = Date.parse(endedIso);
  }
  console.error(`[AnalystResearchJobs] job ${jobId} failed:`, err);
  if (err instanceof Error && err.stack) {
    /** 完整堆栈写到 stderr，便于 Tauri sidecar 控制台 / dev-backend.log 排查 */
    console.error(`[AnalystResearchJobs] stack:\n${err.stack}`);
  }
}

export async function pauseAnalystResearchJobForHitl(
  jobId: string,
  input: {
    requestId: string;
    title: string;
    summary: string;
    resumePayload?: ParsedResearchTeamExecute;
  }
): Promise<void> {
  const db = await getDb();
  const updated = nowIso();
  await db
    .update(analystResearchJob)
    .set({
      status: "awaiting_approval",
      hitlRequestId: input.requestId,
      hitlTitle: input.title,
      hitlSummary: input.summary,
      ...(input.resumePayload ? { resumePayloadJson: input.resumePayload as never } : {}),
      updatedAt: updated,
    })
    .where(eq(analystResearchJob.id, jobId));

  const job = cache.get(jobId);
  if (job) {
    job.status = "awaiting_approval";
    job.hitlRequestId = input.requestId;
    job.hitlTitle = input.title;
    job.hitlSummary = input.summary;
    if (input.resumePayload) {
      job.resumePayload = input.resumePayload;
    }
  }
  console.log(`[AnalystResearchJobs] job ${jobId} paused for HITL request=${input.requestId}`);
}

/**
 * 把 job 恢复 running 并返回 resumePayload。
 * DB 真相源：即使进程重启 cache 丢了，也能从 DB 取到 resumePayload，HITL 审批链路不会断。
 */
export async function resumeAnalystResearchJob(
  jobId: string
): Promise<ParsedResearchTeamExecute | undefined> {
  const db = await getDb();
  /** 先读 DB 看 resumePayload 还在不在 + 当前状态 */
  const rows = await db
    .select()
    .from(analystResearchJob)
    .where(eq(analystResearchJob.id, jobId))
    .limit(1);
  const row = rows[0] as AnalystResearchJobRow | undefined;
  if (!row) {
    /** cache 也可能有（理论上不该），但 DB 没就是真没有 */
    cache.delete(jobId);
    return undefined;
  }

  const resumePayload =
    row.resumePayloadJson ? (row.resumePayloadJson as ParsedResearchTeamExecute) : undefined;

  if (row.status === "awaiting_approval") {
    const updated = nowIso();
    await db
      .update(analystResearchJob)
      .set({
        status: "running",
        hitlRequestId: null,
        hitlTitle: null,
        hitlSummary: null,
        updatedAt: updated,
      })
      .where(eq(analystResearchJob.id, jobId));

    const cached = cache.get(jobId) ?? rowToJob(row);
    cached.status = "running";
    delete cached.hitlRequestId;
    delete cached.hitlTitle;
    delete cached.hitlSummary;
    cache.set(jobId, cached);
    console.log(`[AnalystResearchJobs] job ${jobId} resumed`);
  } else if (!cache.has(jobId)) {
    /** 状态不是 awaiting_approval（异常重派？）也把 cache 回填一下 */
    cache.set(jobId, rowToJob(row));
  }

  return resumePayload;
}

// ─── 读操作（cache 优先，miss 走 DB） ────────────────────────────────────────

export async function getAnalystResearchJob(
  jobId: string
): Promise<AnalystResearchJob | undefined> {
  const cached = cache.get(jobId);
  if (cached) return cached;
  const db = await getDb();
  const rows = await db
    .select()
    .from(analystResearchJob)
    .where(eq(analystResearchJob.id, jobId))
    .limit(1);
  const row = rows[0] as AnalystResearchJobRow | undefined;
  if (!row) return undefined;
  const job = rowToJob(row);
  cache.set(jobId, job);
  return job;
}

/** 通过 workflowRunId 反查最近一个 awaiting_approval 的 job（resolveHitlRequest 需要） */
export async function findPendingAnalystJobByWorkflow(
  workflowRunId: string
): Promise<{ jobId: string; job: AnalystResearchJob } | undefined> {
  /** 先扫 cache（绝大多数情况都命中） */
  for (const [jobId, job] of cache.entries()) {
    if (job.workflowRunId === workflowRunId && job.status === "awaiting_approval") {
      return { jobId, job };
    }
  }
  /** cache 没有就查 DB；尤其进程重启后 restoreRunningWorkflows 还没扫到的窗口很关键 */
  const db = await getDb();
  const rows = await db
    .select()
    .from(analystResearchJob)
    .where(
      and(
        eq(analystResearchJob.workflowRunId, workflowRunId),
        eq(analystResearchJob.status, "awaiting_approval")
      )
    )
    .limit(1);
  const row = rows[0] as AnalystResearchJobRow | undefined;
  if (!row) return undefined;
  const job = rowToJob(row);
  cache.set(row.id, job);
  return { jobId: row.id, job };
}

/**
 * 通过 workflowRunId 反查所有"活着"（running / awaiting_approval）的 job。
 * 用于 workflow cancel / hard-delete 时打断 in-memory 任务，否则前端 UI 已经清，
 * 后端任务还在 spinning（继续写 DB / 调 LLM / 烧 token），还会让前端轮询看到"任务还在跑"。
 */
export async function findActiveAnalystJobsByWorkflow(workflowRunId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const [jobId, job] of cache.entries()) {
    if (
      job.workflowRunId === workflowRunId &&
      (job.status === "running" || job.status === "awaiting_approval")
    ) {
      ids.add(jobId);
    }
  }
  const db = await getDb();
  const rows = await db
    .select({ id: analystResearchJob.id })
    .from(analystResearchJob)
    .where(
      and(
        eq(analystResearchJob.workflowRunId, workflowRunId),
        inArray(analystResearchJob.status, ["running", "awaiting_approval"])
      )
    );
  for (const r of rows) ids.add(r.id);
  return [...ids];
}

// ─── 启动时回填 cache（restoreRunningWorkflows 调） ─────────────────────────

/**
 * 从 DB 把所有 running / awaiting_approval 的 job 回填到 cache，
 * 让进程刚启动那一瞬间也能响应 GET /job/:jobId 等热路径查询。
 */
export async function rehydrateAnalystResearchJobsCache(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(analystResearchJob)
    .where(inArray(analystResearchJob.status, ["running", "awaiting_approval"]));
  let n = 0;
  for (const r of rows as AnalystResearchJobRow[]) {
    cache.set(r.id, rowToJob(r));
    n += 1;
  }
  return n;
}

// ─── 测试钩子（仅 test 使用，不要在生产代码里调） ──────────────────────────

/** @internal 仅供单测，重置内存 cache 模拟进程重启 */
export function __resetAnalystResearchJobsCacheForTest(): void {
  cache.clear();
}
