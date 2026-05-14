/**
 * Analyst Team & MSA API Routes
 *
 * POST /api/v1/analyst/run          — 启动分析师团队分析（异步，立即返回 jobId）
 * GET  /api/v1/analyst/job/:jobId   — 轮询分析任务状态与结果
 * GET  /api/v1/analyst/signals/:workflowId  — 查询工作流的所有分析师信号
 * GET  /api/v1/analyst/fusion/:workflowId   — 查询工作流的信号融合结果
 */

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { analystSignal, agentGroup, agentRoleCatalog, signalFusionResult, workflowRun } from "../db/sqlite/schema";
import {
  ANALYST_TEAM_ROLES,
  runAnalystTeam,
  type AnalystTeamResult,
} from "../runtime/msa/analyst-team";
import type { AgentRole } from "../types/entities";
import { getLatestFusionForWorkflow } from "../runtime/msa/signal-fusion";
import { buildTeamWorkflowGraph } from "../runtime/msa/team-workflow-graph";

export const analystRouter = new Hono();

/** In-memory async job store (local single-process app, no persistence needed). */
interface AnalystJob {
  status: "running" | "completed" | "failed";
  result?: AnalystTeamResult;
  error?: string;
  workflowRunId: string;
  ticker: string;
  startedAt: number;
  endedAt?: number;
}
const analystJobs = new Map<string, AnalystJob>();

/**
 * POST /api/v1/analyst/run
 * Body: { workflowRunId: string, ticker: string, context?: string }
 */
analystRouter.post("/run", async (c) => {
  const body = await c.req.json<{
    workflowRunId: string;
    ticker: string;
    context?: string;
    agentGroupId?: string | null;
    /** 仅运行这些 analyst_* 角色，与编组解析结果取交集 */
    analystRoles?: string[] | null;
  }>();

  if (!body.workflowRunId || !body.ticker) {
    return c.json({ error: "workflowRunId and ticker are required" }, 400);
  }

  // Verify workflow exists
  const db = await getDb();
  if (body.agentGroupId) {
    const grp = await db.select().from(agentGroup).where(eq(agentGroup.id, body.agentGroupId)).limit(1);
    if (!grp[0]) return c.json({ error: "agent group not found" }, 404);
  }
  const wf = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(eq(workflowRun.id, body.workflowRunId))
    .limit(1);

  if (!wf[0]) {
    return c.json({ error: "workflow not found" }, 404);
  }

  const jobId = randomUUID();
  const job: AnalystJob = {
    status: "running",
    workflowRunId: body.workflowRunId,
    ticker: body.ticker,
    startedAt: Date.now(),
  };
  analystJobs.set(jobId, job);

  const roleSet = new Set(ANALYST_TEAM_ROLES);
  const analystRoles =
    Array.isArray(body.analystRoles) && body.analystRoles.length > 0
      ? (body.analystRoles.filter((r): r is AgentRole => typeof r === "string" && roleSet.has(r as AgentRole)) as AgentRole[])
      : undefined;

  // Fire-and-forget: run the heavy analysis in the background.
  void runAnalystTeam({
    workflowRunId: body.workflowRunId,
    ticker: body.ticker,
    context: body.context,
    agentGroupId: body.agentGroupId,
    analystRoles,
  })
    .then((result) => {
      job.status = "completed";
      job.result = result;
      job.endedAt = Date.now();
      console.log(`[AnalystRouter] job ${jobId} completed in ${job.endedAt - job.startedAt}ms`);
    })
    .catch((err) => {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      job.endedAt = Date.now();
      console.error(`[AnalystRouter] job ${jobId} failed:`, err);
    });

  return c.json({ ok: true, jobId, status: "running" }, 202);
});

/**
 * GET /api/v1/analyst/job/:jobId
 * 轮询分析任务状态与结果
 */
analystRouter.get("/job/:jobId", (c) => {
  const jobId = c.req.param("jobId");
  const job = analystJobs.get(jobId);
  if (!job) return c.json({ error: "job not found" }, 404);
  return c.json({
    ok: true,
    jobId,
    status: job.status,
    workflowRunId: job.workflowRunId,
    ticker: job.ticker,
    elapsedMs: Date.now() - job.startedAt,
    result: job.result,
    error: job.error,
  });
});

/**
 * GET /api/v1/analyst/workflow/:workflowId/team-graph
 * Agent 拓扑、边统计、交互轨迹与 tool/mcp 调用（供 IDE 画布）
 */
analystRouter.get("/workflow/:workflowId/team-graph", async (c) => {
  const workflowRunId = c.req.param("workflowId");
  const db = await getDb();
  const wf = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(eq(workflowRun.id, workflowRunId))
    .limit(1);
  if (!wf[0]) return c.json({ error: "workflow not found" }, 404);
  const data = await buildTeamWorkflowGraph(workflowRunId);
  return c.json({ ok: true, data });
});

/**
 * GET /api/v1/analyst/signals/:workflowId
 */
analystRouter.get("/signals/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");
  const db = await getDb();

  const signals = await db
    .select()
    .from(analystSignal)
    .where(eq(analystSignal.workflowRunId, workflowId))
    .orderBy(sql`created_at ASC`);

  return c.json({ ok: true, data: signals });
});

/**
 * GET /api/v1/analyst/fusion/:workflowId
 */
analystRouter.get("/fusion/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");

  const fusion = await getLatestFusionForWorkflow(workflowId);
  if (!fusion) {
    return c.json({ ok: true, data: null });
  }

  return c.json({ ok: true, data: fusion });
});

/**
 * GET /api/v1/analyst/roles
 * 返回角色字典（前端展示用）
 */
analystRouter.get("/roles", async (c) => {
  const db = await getDb();
  const roles = await db.select().from(agentRoleCatalog);
  return c.json({ ok: true, data: roles });
});

/**
 * GET /api/v1/analyst/fusion/history
 * 查询历史融合结果（带分页）
 * Query: workflowRunId?, ticker?, limit?=20, offset?=0
 */
analystRouter.get("/fusion/history", async (c) => {
  const db = await getDb();
  const ticker = c.req.query("ticker");
  const limitStr = c.req.query("limit") ?? "20";
  const offsetStr = c.req.query("offset") ?? "0";

  const limit = Math.min(100, parseInt(limitStr, 10) || 20);
  const offset = parseInt(offsetStr, 10) || 0;

  const query = db
    .select()
    .from(signalFusionResult)
    .orderBy(sql`created_at DESC`)
    .limit(limit)
    .offset(offset);

  let results;
  if (ticker) {
    results = await db
      .select()
      .from(signalFusionResult)
      .where(eq(signalFusionResult.ticker, ticker))
      .orderBy(sql`created_at DESC`)
      .limit(limit)
      .offset(offset);
  } else {
    results = await query;
  }

  // #region agent log
  const sample = results[0] as Record<string, unknown> | undefined;
  fetch("http://127.0.0.1:7617/ingest/82ec5b74-0b73-4815-bb8d-d6f541a02c64", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "6ea60d" },
    body: JSON.stringify({
      sessionId: "6ea60d",
      hypothesisId: "H2",
      location: "analyst.routes.ts:fusion/history",
      message: "fusion history query",
      data: {
        rowCount: results.length,
        sampleKeys: sample ? Object.keys(sample) : [],
        hasFusedSignal: Boolean(sample && "fusedSignal" in sample),
      },
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion

  return c.json({ ok: true, data: results });
});
