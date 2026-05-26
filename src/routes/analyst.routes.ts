/**
 * Analyst Team & MSA API Routes
 *
 * POST /api/v1/analyst/run          — 启动研究团队分析（异步，立即返回 jobId；经 Orchestrator 派发）
 * GET  /api/v1/analyst/job/:jobId   — 轮询分析任务状态与结果
 * GET  /api/v1/analyst/signals/:workflowId  — 查询工作流的所有分析师信号
 * GET  /api/v1/analyst/fusion/:workflowId   — 查询工作流的信号融合结果
 */

import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import {
  agentGroup,
  agentRoleCatalog,
  analystSignal,
  signalFusionResult,
  workflowRun,
} from "../db/sqlite/schema";
import { dispatchTaskToRole } from "../runtime/agent-pool";
import {
  failAnalystResearchJob,
  getAnalystResearchJob,
  registerAnalystResearchJob,
} from "../runtime/msa/analyst-research-jobs";
import { RESEARCH_TEAM_SLOT_SET } from "../runtime/msa/analyst-team";
import { getLatestFusionForWorkflow } from "../runtime/msa/signal-fusion";
import { buildTeamWorkflowGraph } from "../runtime/msa/team-workflow-graph";
import type { AgentRole } from "../types/entities";
import { resolveResearchScope, type ResearchScopeInput } from "../types/research-scope";

export const analystRouter = new Hono();

/**
 * POST /api/v1/analyst/run
 * Body: { workflowRunId: string, ticker: string, context?: string }
 */
analystRouter.post("/run", async (c) => {
  const body = await c.req.json<{
    workflowRunId: string;
    ticker?: string;
    scope?: ResearchScopeInput | null;
    context?: string;
    agentGroupId?: string | null;
    analystRoles?: string[] | null;
    analystDefinitionIds?: string[] | null;
    /**
     * HITL 三档模式，写入 workflow.loopOptionsJson.hitlMode
     *   - 'off'：永不主动；仅硬规则（资金/规模/失败重试）触发
     *   - 'ai'：默认 — Orchestrator 自评 needed=true 或硬规则命中才触发
     *   - 'always'：每次规划都触发
     * 详见 docs/HITL_REDESIGN.md
     *
     * P1-H 后：v1 入参 `hitlTeam` 已移除；外部客户端请直接传 `hitlMode`。
     * 旧客户端若仍传 `hitlTeam` 会被 zod .strip() 忽略，不会报错（兼容性硬退场）。
     */
    hitlMode?: "off" | "ai" | "always";
  }>();

  if (!body.workflowRunId) {
    return c.json({ error: "workflowRunId is required" }, 400);
  }

  const scope = resolveResearchScope({ ticker: body.ticker, scope: body.scope });
  if (!body.ticker?.trim() && !body.scope && scope.primarySymbol === "UNKNOWN") {
    return c.json({ error: "ticker or scope.symbols is required" }, 400);
  }

  const db = await getDb();
  if (body.agentGroupId) {
    const grp = await db
      .select()
      .from(agentGroup)
      .where(eq(agentGroup.id, body.agentGroupId))
      .limit(1);
    if (!grp[0]) return c.json({ error: "agent group not found" }, 404);
  }
  const wf = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.id, body.workflowRunId))
    .limit(1);

  if (!wf[0]) {
    return c.json({ error: "workflow not found" }, 404);
  }

  // 把 hitl 偏好（v2 hitlMode）同步到 workflow.loopOptionsJson，
  // 让 evaluateTeamHitlTrigger 读取到。v1 字段已通过 migration 0053 退场。
  if (body.hitlMode === "off" || body.hitlMode === "ai" || body.hitlMode === "always") {
    const currentLoopOptions =
      (wf[0].loopOptionsJson as Record<string, unknown> | null) ?? {};
    const nextLoopOptions: Record<string, unknown> = {
      ...currentLoopOptions,
      hitlMode: body.hitlMode,
    };
    await db
      .update(workflowRun)
      .set({ loopOptionsJson: nextLoopOptions as never })
      .where(eq(workflowRun.id, body.workflowRunId));
  }

  const jobId = randomUUID();
  await registerAnalystResearchJob(jobId, {
    status: "running",
    workflowRunId: body.workflowRunId,
    ticker: scope.displayLabel,
    startedAt: Date.now(),
  });

  const analystRoles =
    Array.isArray(body.analystRoles) && body.analystRoles.length > 0
      ? (body.analystRoles.filter(
          (r): r is AgentRole => typeof r === "string" && RESEARCH_TEAM_SLOT_SET.has(r)
        ) as AgentRole[])
      : undefined;

  const analystDefinitionIds =
    Array.isArray(body.analystDefinitionIds) && body.analystDefinitionIds.length > 0
      ? body.analystDefinitionIds.filter(
          (x): x is string => typeof x === "string" && x.trim().length > 0
        )
      : undefined;

  const taskId = randomUUID();
  try {
    await dispatchTaskToRole({
      workflowId: body.workflowRunId,
      role: "orchestrator",
      payload: {
        taskId,
        taskType: "research_team_execute",
        assignedRole: "orchestrator",
        params: {
          jobId,
          ticker: body.ticker ?? scope.primarySymbol,
          scope: body.scope ?? undefined,
          context: body.context,
          agentGroupId: body.agentGroupId ?? undefined,
          analystRoles: analystRoles ?? undefined,
          analystDefinitionIds: analystDefinitionIds ?? undefined,
        },
      },
    });
  } catch (err) {
    await failAnalystResearchJob(jobId, err);
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), jobId },
      500
    );
  }

  return c.json({ ok: true, jobId, status: "running" }, 202);
});

/**
 * GET /api/v1/analyst/job/:jobId
 * 轮询分析任务状态与结果。
 * P0-2 起 `getAnalystResearchJob` 是 async（DB 兜底），handler 也必须 async。
 */
analystRouter.get("/job/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = await getAnalystResearchJob(jobId);
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
    hitlRequestId: job.hitlRequestId,
    hitlTitle: job.hitlTitle,
    hitlSummary: job.hitlSummary,
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

  const limit = Math.min(100, Number.parseInt(limitStr, 10) || 20);
  const offset = Number.parseInt(offsetStr, 10) || 0;

  const query = db
    .select()
    .from(signalFusionResult)
    .orderBy(sql`created_at DESC`)
    .limit(limit)
    .offset(offset);

  const results = ticker
    ? await db
        .select()
        .from(signalFusionResult)
        .where(eq(signalFusionResult.ticker, ticker))
        .orderBy(sql`created_at DESC`)
        .limit(limit)
        .offset(offset)
    : await query;

  return c.json({ ok: true, data: results });
});
