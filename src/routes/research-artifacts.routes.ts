/**
 * Research artifact read API routes
 *
 * Agent 研究统一从 chat session turn 进入：
 * POST /api/v1/chat/sessions/:sessionId/turns
 *
 * 本路由只保留历史研究产物 / 拓扑的只读查询，不再提供 Agent 启动接口。
 * GET  /api/v1/research-artifacts/signals/:workflowId  — 查询历史信号
 * GET  /api/v1/research-artifacts/fusion/:workflowId   — 查询历史融合结果
 */

import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import { analystSignal, signalFusionResult, workflowRun } from "../db/sqlite/schema";
import { buildTeamWorkflowGraph } from "../runtime/host/team-workflow-graph";
import { getLatestFusionForWorkflow } from "../runtime/research-team/research-artifacts";
import { SEED_AGENT_ROLE_CATALOG } from "../runtime/seed-agent-roles";

export const researchArtifactsRouter = new Hono();

/**
 * GET /api/v1/research-artifacts/workflow/:workflowId/team-graph
 * Agent 拓扑、边统计、交互轨迹与 tool/mcp 调用（供 IDE 画布）
 */
researchArtifactsRouter.get("/workflow/:workflowId/team-graph", async (c) => {
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
 * GET /api/v1/research-artifacts/signals/:workflowId
 */
researchArtifactsRouter.get("/signals/:workflowId", async (c) => {
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
 * GET /api/v1/research-artifacts/fusion/:workflowId
 */
researchArtifactsRouter.get("/fusion/:workflowId", async (c) => {
  const workflowId = c.req.param("workflowId");

  const fusion = await getLatestFusionForWorkflow(workflowId);
  if (!fusion) {
    return c.json({ ok: true, data: null });
  }

  return c.json({ ok: true, data: fusion });
});

/**
 * GET /api/v1/research-artifacts/roles
 * 返回角色字典（前端展示用）
 *
 * 历史：曾从 `agent_role_catalog` 表 select；该表 22 行内容由 migration 0004 硬编码
 * 写入、运行时永不变更、零业务消费方（前端 `getAgentRoles` 声明但无调用方）。
 * 收敛后直接返回 `SEED_AGENT_ROLE_CATALOG` 常量，端点 schema 与原表行一致。
 */
researchArtifactsRouter.get("/roles", async (c) => {
  return c.json({ ok: true, data: SEED_AGENT_ROLE_CATALOG });
});

/**
 * GET /api/v1/research-artifacts/fusion/history
 * 查询历史融合结果（带分页）
 * Query: workflowRunId?, ticker?, limit?=20, offset?=0
 */
researchArtifactsRouter.get("/fusion/history", async (c) => {
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
