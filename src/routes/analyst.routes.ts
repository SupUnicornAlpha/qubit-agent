/**
 * Analyst Team & MSA API Routes
 *
 * POST /api/v1/analyst/run          — 启动分析师团队分析
 * GET  /api/v1/analyst/signals/:workflowId  — 查询工作流的所有分析师信号
 * GET  /api/v1/analyst/fusion/:workflowId   — 查询工作流的信号融合结果
 */

import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { analystSignal, agentRoleCatalog, signalFusionResult, workflowRun } from "../db/sqlite/schema";
import { runAnalystTeam } from "../runtime/msa/analyst-team";
import { getLatestFusionForWorkflow } from "../runtime/msa/signal-fusion";

export const analystRouter = new Hono();

/**
 * POST /api/v1/analyst/run
 * Body: { workflowRunId: string, ticker: string, context?: string }
 */
analystRouter.post("/run", async (c) => {
  const body = await c.req.json<{
    workflowRunId: string;
    ticker: string;
    context?: string;
  }>();

  if (!body.workflowRunId || !body.ticker) {
    return c.json({ error: "workflowRunId and ticker are required" }, 400);
  }

  // Verify workflow exists
  const db = await getDb();
  const wf = await db
    .select({ id: workflowRun.id })
    .from(workflowRun)
    .where(eq(workflowRun.id, body.workflowRunId))
    .limit(1);

  if (!wf[0]) {
    return c.json({ error: "workflow not found" }, 404);
  }

  try {
    const result = await runAnalystTeam({
      workflowRunId: body.workflowRunId,
      ticker: body.ticker,
      context: body.context,
    });

    return c.json({
      ok: true,
      data: result,
    });
  } catch (err) {
    console.error("[AnalystRouter] run failed:", err);
    return c.json({ error: (err as Error).message }, 500);
  }
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

  return c.json({ ok: true, data: results });
});
