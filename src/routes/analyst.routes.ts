/**
 * Analyst Team & MSA API Routes
 *
 * POST /api/v1/analyst/run          — 启动研究团队分析（异步，立即返回 jobId；经 Orchestrator 派发）
 * GET  /api/v1/analyst/job/:jobId   — 轮询分析任务状态与结果
 * GET  /api/v1/analyst/signals/:workflowId  — 查询工作流的所有分析师信号
 * GET  /api/v1/analyst/fusion/:workflowId   — 查询工作流的信号融合结果
 */

import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import {
  analystSignal,
  researchTeamInteraction,
  signalFusionResult,
  workflowRun,
} from "../db/sqlite/schema";
import { dispatchTaskToRole } from "../runtime/agent-pool";
import { getAnalystResearchJob } from "../runtime/msa/analyst-research-jobs";
import { launchAnalystTeam, LaunchAnalystTeamError } from "../runtime/msa/launch-analyst-team";
import { logResearchTeamInteraction } from "../runtime/research-team/interaction-log";
import { getLatestFusionForWorkflow } from "../runtime/msa/signal-fusion";
import { buildTeamWorkflowGraph } from "../runtime/msa/team-workflow-graph";
import { SEED_AGENT_ROLE_CATALOG } from "../runtime/seed-agent-roles";
import type { ResearchScopeInput } from "../types/research-scope";

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
    /**
     * Agent 底座/引擎：每个角色单轮 reason 用哪个引擎（docs/CLI_AGENT_PROJECTION_DESIGN.md 模型 B）。
     * 写入 workflow.loopOptionsJson.roleReasoner，由 runResearchTeamSlotReact 的 resolveRoleReasoner 读取。
     *   - 'native'（默认）：自研进程内 ReAct
     *   - 'claude_cli' / 'codex_cli'：子进程 CLI 作为单角色 reason 引擎
     * 注意：这与 workflow.loop_kind 正交——loop_kind 保持 native（仍走 MSA 编排），仅替换角色 reason 引擎。
     */
    roleReasoner?: "native" | "claude_cli" | "codex_cli";
  }>();

  try {
    const launched = await launchAnalystTeam({
      workflowRunId: body.workflowRunId,
      ...(body.ticker !== undefined ? { ticker: body.ticker } : {}),
      ...(body.scope !== undefined ? { scope: body.scope } : {}),
      ...(body.context !== undefined ? { context: body.context } : {}),
      ...(body.agentGroupId !== undefined ? { agentGroupId: body.agentGroupId } : {}),
      ...(body.analystRoles !== undefined ? { analystRoles: body.analystRoles } : {}),
      ...(body.analystDefinitionIds !== undefined
        ? { analystDefinitionIds: body.analystDefinitionIds }
        : {}),
      ...(body.hitlMode !== undefined ? { hitlMode: body.hitlMode } : {}),
      ...(body.roleReasoner !== undefined ? { roleReasoner: body.roleReasoner } : {}),
    });
    return c.json({ ok: true, jobId: launched.jobId, status: "running" }, 202);
  } catch (err) {
    if (err instanceof LaunchAnalystTeamError) {
      if (err.status === 404) {
        return c.json({ ok: false, error: err.message, code: err.code }, 404);
      }
      return c.json({ ok: false, error: err.message, code: err.code }, 400);
    }
    throw err;
  }
});

/**
 * POST /api/v1/analyst/orchestrator-chat
 *
 * 研究团队页「对话消息」入口（区别于「启动团队分析」按钮）。不再写死跑全队，而是把消息
 * 交给 Orchestrator 跑 ReAct 自主判断：直接回答 / assign_task 派给特定子 agent /
 * run_analyst_team 跑全队（决策指引在 reason.ts 注入）。上下文用**本会话的最近对话**
 * （researchTeamInteraction transcript），不载入历史报告。
 *
 * body: { workflowRunId, message, hitlMode? }
 */
analystRouter.post("/orchestrator-chat", async (c) => {
  type OrchestratorChatBody = {
    workflowRunId?: string;
    message?: string;
    hitlMode?: "off" | "ai" | "always";
    roleReasoner?: "native" | "claude_cli" | "codex_cli";
    experience?: "native" | "coding_agent";
  };
  const body = await c.req
    .json<OrchestratorChatBody>()
    .catch(() => ({}) as OrchestratorChatBody);
  const workflowRunId = (body.workflowRunId ?? "").trim();
  const message = (body.message ?? "").trim();
  if (!workflowRunId) return c.json({ error: "workflowRunId is required" }, 400);
  if (!message) return c.json({ error: "message is required" }, 400);

  const db = await getDb();
  const wf = await db.select().from(workflowRun).where(eq(workflowRun.id, workflowRunId)).limit(1);
  if (!wf[0]) return c.json({ error: "workflow not found" }, 404);

  // 与 /run 一致：标 running + 重置 startedAt（防 stuck 看门狗误杀）。
  await db
    .update(workflowRun)
    .set({ status: "running", startedAt: new Date().toISOString(), endedAt: null })
    .where(eq(workflowRun.id, workflowRunId));

  {
    const hitlValid =
      body.hitlMode === "off" || body.hitlMode === "ai" || body.hitlMode === "always";
    const reasonerValid =
      body.roleReasoner === "native" ||
      body.roleReasoner === "claude_cli" ||
      body.roleReasoner === "codex_cli";
    const experienceValid =
      body.experience === "native" || body.experience === "coding_agent";
    if (hitlValid || reasonerValid || experienceValid) {
      const cur = (wf[0].loopOptionsJson as Record<string, unknown> | null) ?? {};
      await db
        .update(workflowRun)
        .set({
          loopOptionsJson: {
            ...cur,
            ...(hitlValid ? { hitlMode: body.hitlMode } : {}),
            ...(reasonerValid ? { roleReasoner: body.roleReasoner } : {}),
            ...(experienceValid ? { experience: body.experience } : {}),
          } as never,
        })
        .where(eq(workflowRun.id, workflowRunId));
    }
  }

  // 用户消息落库为 user→orchestrator 交互（右栏展示 + 进入会话 transcript）。
  await logResearchTeamInteraction({
    workflowRunId,
    fromRole: "user",
    toRole: "orchestrator",
    kind: "llm_message",
    contentText: message.slice(0, 4000),
  });

  // 本会话上下文 = 该 workflow 最近的对话/事件（不含本条 user 消息，避免重复）。
  const recent = await db
    .select({
      fromRole: researchTeamInteraction.fromRole,
      toRole: researchTeamInteraction.toRole,
      contentText: researchTeamInteraction.contentText,
    })
    .from(researchTeamInteraction)
    .where(eq(researchTeamInteraction.workflowRunId, workflowRunId))
    .orderBy(desc(researchTeamInteraction.createdAt))
    .limit(31);
  recent.reverse();
  const transcript = recent
    .slice(0, -1) // 去掉刚落库的本条
    .map((r) => `- ${r.fromRole} → ${r.toRole}: ${(r.contentText ?? "").slice(0, 600)}`)
    .join("\n");
  const context = transcript
    ? `## 本次会话上下文（最近对话，按时间）\n${transcript}`
    : "（本会话暂无历史对话）";

  const taskId = randomUUID();
  try {
    await dispatchTaskToRole({
      workflowId: workflowRunId,
      role: "orchestrator",
      payload: {
        taskId,
        taskType: "orchestrator_chat",
        assignedRole: "orchestrator",
        params: { goal: message, context },
      },
    });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
  return c.json({ ok: true, status: "running" }, 202);
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
 *
 * 历史：曾从 `agent_role_catalog` 表 select；该表 22 行内容由 migration 0004 硬编码
 * 写入、运行时永不变更、零业务消费方（前端 `getAgentRoles` 声明但无调用方）。
 * 收敛后直接返回 `SEED_AGENT_ROLE_CATALOG` 常量，端点 schema 与原表行一致。
 */
analystRouter.get("/roles", async (c) => {
  return c.json({ ok: true, data: SEED_AGENT_ROLE_CATALOG });
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
