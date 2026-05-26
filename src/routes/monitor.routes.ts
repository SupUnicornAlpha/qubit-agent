import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import {
  a2aMessage,
  agentDefinition,
  agentInstance,
  agentStep,
  sandboxViolationLog,
  toolCallLog,
  workflowRun,
} from "../db/sqlite/schema";
import {
  createEvalDataset,
  getEvalRunDetail,
  listEvalDatasets,
  listEvalRuns,
  runEval,
} from "../runtime/eval/pipeline";
import {
  ackAlert,
  createAlertsFromWorkflowQuality,
  createStuckWorkflowAlerts,
  listAlerts,
  resolveAlert,
  resolveAlertsByScope,
} from "../runtime/monitor/alert-service";
import {
  scanAllSystemAlerts,
  scanMcpCircuitOpenAlerts,
  scanTokenAnomalyAlerts,
} from "../runtime/monitor/alert-scanners";
import { listFailures, type FailureScope } from "../runtime/monitor/failure-list";
import { getLlmUsageSummary } from "../runtime/monitor/llm-usage";
import { getMcpDiagnostics } from "../runtime/monitor/mcp-diagnostics";
import { getMcpSummary } from "../runtime/monitor/mcp-summary";
import { getToolDiagnostics } from "../runtime/monitor/tools-diagnostics";
import { getMonitorSummary } from "../runtime/monitor/monitor-summary";
import { getSkillsSummary } from "../runtime/monitor/skills-summary";
import { getToolsSummary, type ToolKind } from "../runtime/monitor/tools-summary";
import {
  aggregateAgentRuntimeMetrics,
  createWorkflowQualitySnapshot,
  getAgentRuntimeDetail,
  listAgentRuntimeMetrics,
  listWorkflowQualitySnapshots,
} from "../runtime/monitor/quality-metrics";
import { getWorkflowObservability } from "../runtime/monitor/workflow-observability";

export const monitorRouter = new Hono();

monitorRouter.get("/summary", async (c) => {
  const sessionId = c.req.query("sessionId");
  const stuckMinutes = c.req.query("stuckMinutes");
  const data = await getMonitorSummary({
    sessionId: sessionId || undefined,
    stuckMinutes: stuckMinutes ? Number(stuckMinutes) : undefined,
  });
  return c.json({ ok: true, data });
});

monitorRouter.post("/alerts/scan-stuck", async (c) => {
  const body = await c.req.json<{ stuckMinutes?: number }>().catch(() => ({}));
  const data = await createStuckWorkflowAlerts(body.stuckMinutes ?? 120);
  return c.json({ ok: true, data });
});

/**
 * 监控 V2 P2：系统级 alert 扫描（mcp_circuit_open + token_anomaly）。
 *
 * 详见 docs/MONITORING_V2_DESIGN.md §6.9 与 src/runtime/monitor/alert-scanners.ts。
 * 推荐 5min/次定时调用；body 各参数可选。
 */
monitorRouter.post("/alerts/scan-system", async (c) => {
  type Body = {
    mcpStuckMinutes?: number;
    tokenRatioThreshold?: number;
    tokenWindowMinutes?: number;
  };
  /**
   * `c.req.json<T>().catch(() => ({}))` 会被 TS 推断成 `T | {}`，必须显式 cast 成 T；
   * 否则 exactOptionalPropertyTypes 下访问可选字段会触发 TS2339。
   */
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);
  const input: Parameters<typeof scanAllSystemAlerts>[0] = {};
  if (body.mcpStuckMinutes !== undefined) input.mcpStuckMinutes = body.mcpStuckMinutes;
  if (body.tokenRatioThreshold !== undefined)
    input.tokenRatioThreshold = body.tokenRatioThreshold;
  if (body.tokenWindowMinutes !== undefined)
    input.tokenWindowMinutes = body.tokenWindowMinutes;
  const data = await scanAllSystemAlerts(input);
  return c.json({ ok: true, data });
});

/** 单独触发 mcp_circuit_open 扫描（运维 / 测试用） */
monitorRouter.post("/alerts/scan-mcp", async (c) => {
  type Body = { stuckMinutes?: number };
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);
  const input: Parameters<typeof scanMcpCircuitOpenAlerts>[0] = {};
  if (body.stuckMinutes !== undefined) input.stuckMinutes = body.stuckMinutes;
  const data = await scanMcpCircuitOpenAlerts(input);
  return c.json({ ok: true, data });
});

/** 单独触发 token_anomaly 扫描 */
monitorRouter.post("/alerts/scan-token", async (c) => {
  type Body = {
    ratioThreshold?: number;
    windowMinutes?: number;
    baselineMinTokens?: number;
  };
  const body: Body = await c.req.json<Body>().catch(() => ({}) as Body);
  const input: Parameters<typeof scanTokenAnomalyAlerts>[0] = {};
  if (body.ratioThreshold !== undefined) input.ratioThreshold = body.ratioThreshold;
  if (body.windowMinutes !== undefined) input.windowMinutes = body.windowMinutes;
  if (body.baselineMinTokens !== undefined)
    input.baselineMinTokens = body.baselineMinTokens;
  const data = await scanTokenAnomalyAlerts(input);
  return c.json({ ok: true, data });
});

monitorRouter.get("/sessions/:id/overview", async (c) => {
  const db = await getDb();
  const sessionId = c.req.param("id");
  const workflows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.sessionId, sessionId))
    .orderBy(desc(workflowRun.startedAt));
  return c.json({
    data: {
      sessionId,
      workflowCount: workflows.length,
      running: workflows.filter((item) => item.status === "running").length,
      failed: workflows.filter((item) => item.status === "failed").length,
      latestWorkflow: workflows[0] ?? null,
      workflows,
    },
  });
});

monitorRouter.get("/workflows/:id/timeline", async (c) => {
  const db = await getDb();
  const workflowId = c.req.param("id");
  const [instances, steps] = await Promise.all([
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowId)),
    db
      .select()
      .from(agentStep)
      .where(eq(agentStep.workflowRunId, workflowId))
      .orderBy(agentStep.createdAt),
  ]);
  const stepIds = steps.map((item) => item.id);
  const tools =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];
  const toolsByStep = new Map<string, typeof tools>();
  for (const tool of tools) {
    const bucket = toolsByStep.get(tool.agentStepId) ?? [];
    bucket.push(tool);
    toolsByStep.set(tool.agentStepId, bucket);
  }
  return c.json({
    data: {
      workflowId,
      instances,
      steps: steps.map((step) => ({
        ...step,
        toolCalls: toolsByStep.get(step.id) ?? [],
      })),
    },
  });
});

monitorRouter.get("/workflows/:id/sandbox-violations", async (c) => {
  const db = await getDb();
  const workflowId = c.req.param("id");
  const rows = await db
    .select()
    .from(sandboxViolationLog)
    .where(eq(sandboxViolationLog.workflowRunId, workflowId))
    .orderBy(desc(sandboxViolationLog.createdAt));
  return c.json({ data: rows });
});

monitorRouter.get("/sessions/:id/agents-board", async (c) => {
  const db = await getDb();
  const sessionId = c.req.param("id");
  const workflows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.sessionId, sessionId))
    .orderBy(desc(workflowRun.startedAt))
    .limit(20);
  const workflowIds = workflows.map((w) => w.id);
  if (workflowIds.length === 0) return c.json({ data: { sessionId, agents: [] } });
  const workflowMeta = new Map(
    workflows.map(
      (w) => [w.id, { startedAt: w.startedAt, status: w.status, mode: w.mode }] as const
    )
  );
  const [instances, definitions, steps] = await Promise.all([
    db.select().from(agentInstance).where(inArray(agentInstance.workflowRunId, workflowIds)),
    db.select().from(agentDefinition),
    db
      .select()
      .from(agentStep)
      .where(inArray(agentStep.workflowRunId, workflowIds))
      .orderBy(desc(agentStep.createdAt)),
  ]);
  const definitionMap = new Map(definitions.map((item) => [item.id, item]));
  const latestStepByInstance = new Map<string, (typeof steps)[number]>();
  for (const step of steps) {
    if (!latestStepByInstance.has(step.agentInstanceId)) {
      latestStepByInstance.set(step.agentInstanceId, step);
    }
  }
  const current = instances;
  return c.json({
    data: {
      sessionId,
      agents: current.map((instance) => {
        const def = definitionMap.get(instance.definitionId);
        const latestStep = latestStepByInstance.get(instance.id);
        const wf = workflowMeta.get(instance.workflowRunId);
        return {
          instanceId: instance.id,
          workflowRunId: instance.workflowRunId,
          workflowStartedAt: wf?.startedAt ?? null,
          workflowStatus: wf?.status ?? null,
          workflowMode: wf?.mode ?? null,
          role: def?.role ?? "unknown",
          name: def?.name ?? "unknown",
          status: instance.status,
          currentIteration: instance.currentIteration,
          lastError: instance.errorMessage,
          latestStep: latestStep
            ? {
                phase: latestStep.phase,
                createdAt: latestStep.createdAt,
                stepIndex: latestStep.stepIndex,
              }
            : null,
        };
      }),
    },
  });
});

monitorRouter.get("/sessions/:id/a2a-messages", async (c) => {
  const db = await getDb();
  const sessionId = c.req.param("id");
  const limit = Math.max(1, Math.min(500, Number(c.req.query("limit") ?? "100")));
  const workflows = await db
    .select()
    .from(workflowRun)
    .where(eq(workflowRun.sessionId, sessionId))
    .orderBy(desc(workflowRun.startedAt))
    .limit(50);
  const workflowIds = workflows.map((w) => w.id);
  if (workflowIds.length === 0) return c.json({ data: { sessionId, messages: [] } });

  const [instances, definitions, messages] = await Promise.all([
    db.select().from(agentInstance),
    db.select().from(agentDefinition),
    db
      .select()
      .from(a2aMessage)
      .orderBy(desc(a2aMessage.createdAt))
      .limit(limit * 4),
  ]);

  const defById = new Map(definitions.map((d) => [d.id, d]));
  const instanceRoleById = new Map(
    instances.map((i) => [i.id, defById.get(i.definitionId)?.role ?? "unknown"])
  );
  const filtered = messages.filter((m) => workflowIds.includes(m.workflowRunId)).slice(0, limit);

  return c.json({
    data: {
      sessionId,
      messages: filtered.map((m) => ({
        ...m,
        senderRole: instanceRoleById.get(m.senderInstanceId) ?? "unknown",
        receiverRole: m.receiverInstanceId
          ? (instanceRoleById.get(m.receiverInstanceId) ?? "unknown")
          : null,
      })),
    },
  });
});

/**
 * 工作流列表（用于前端工作流选择器 / 监控页）。
 *
 * 性能优化：
 *   - 过滤与排序全部下推到 SQL（之前是 SELECT * + JS 内存过滤 + slice(200)，
 *     在 workflow_run 表行数膨胀时极慢；新版严格 LIMIT，并依赖 0037 迁移新增的索引）。
 *   - 仅选取下拉框 / 监控列表实际需要的字段（goal、mode、status、startedAt、endedAt、source、sessionId、projectId 等），
 *     避免拉取 loop_options_json / langgraph_thread_id 等较长 JSON 文本字段。
 *   - 默认 LIMIT 200，可通过 `?limit=` 调整，上限 500。
 */
monitorRouter.get("/workflows", async (c) => {
  const db = await getDb();
  const sessionId = c.req.query("sessionId");
  const status = c.req.query("status");
  const mode = c.req.query("mode");
  const projectId = c.req.query("projectId");
  const includeCancelled = c.req.query("includeCancelled") === "true";
  const limitParam = Number(c.req.query("limit") ?? "200");
  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(500, limitParam)) : 200;

  const conds = [
    sessionId ? eq(workflowRun.sessionId, sessionId) : undefined,
    status ? eq(workflowRun.status, status as typeof workflowRun.$inferSelect.status) : undefined,
    mode ? eq(workflowRun.mode, mode as typeof workflowRun.$inferSelect.mode) : undefined,
    projectId ? eq(workflowRun.projectId, projectId) : undefined,
  ].filter(Boolean);

  const where =
    conds.length === 0
      ? undefined
      : conds.length === 1
        ? (conds[0] as ReturnType<typeof eq>)
        : and(...(conds as ReturnType<typeof eq>[]));

  const baseQuery = db
    .select({
      id: workflowRun.id,
      projectId: workflowRun.projectId,
      sessionId: workflowRun.sessionId,
      goal: workflowRun.goal,
      mode: workflowRun.mode,
      source: workflowRun.source,
      status: workflowRun.status,
      startedAt: workflowRun.startedAt,
      endedAt: workflowRun.endedAt,
      agentGroupId: workflowRun.agentGroupId,
      loopKind: workflowRun.loopKind,
      executionPath: workflowRun.executionPath,
    })
    .from(workflowRun);

  const rows = where
    ? await baseQuery.where(where).orderBy(desc(workflowRun.startedAt)).limit(limit)
    : await baseQuery.orderBy(desc(workflowRun.startedAt)).limit(limit);

  const filtered = includeCancelled ? rows : rows.filter((r) => r.status !== "cancelled");
  return c.json({ data: filtered });
});

monitorRouter.get("/workflows/:id/observability", async (c) => {
  const workflowId = c.req.param("id");
  const data = await getWorkflowObservability(workflowId);
  return c.json({ ok: true, data });
});

monitorRouter.get("/workflows/:id/detail", async (c) => {
  const db = await getDb();
  const workflowId = c.req.param("id");
  const [workflowRows, instances, steps, violations] = await Promise.all([
    db.select().from(workflowRun).where(eq(workflowRun.id, workflowId)).limit(1),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowId)),
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowId)),
    db.select().from(sandboxViolationLog).where(eq(sandboxViolationLog.workflowRunId, workflowId)),
  ]);
  if (!workflowRows[0]) return c.json({ error: "workflow not found", workflowId }, 404);
  const stepIds = steps.map((step) => step.id);
  const tools =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];
  const usedTools = tools;
  return c.json({
    data: {
      workflow: workflowRows[0],
      instances,
      steps,
      toolCalls: usedTools,
      sandboxViolations: violations,
    },
  });
});

monitorRouter.post("/quality/workflows/:id/snapshot", async (c) => {
  const workflowId = c.req.param("id");
  const data = await createWorkflowQualitySnapshot(workflowId);
  return c.json({ ok: true, data });
});

monitorRouter.get("/quality/workflows/:id/snapshots", async (c) => {
  const workflowId = c.req.param("id");
  const data = await listWorkflowQualitySnapshots(workflowId);
  return c.json({ ok: true, data });
});

monitorRouter.post("/quality/agents/aggregate", async (c) => {
  const body = await c.req.json<{ windowStart?: string; windowEnd?: string }>().catch(() => ({}));
  const data = await aggregateAgentRuntimeMetrics({
    windowStart: body.windowStart,
    windowEnd: body.windowEnd,
  });
  return c.json({ ok: true, data });
});

monitorRouter.get("/quality/agents/metrics", async (c) => {
  const windowStart = c.req.query("windowStart");
  const windowEnd = c.req.query("windowEnd");
  const data = await listAgentRuntimeMetrics({ windowStart, windowEnd });
  return c.json({ ok: true, data });
});

/**
 * Agent 维度下钻详情：byTool / byMcp / bySkill / errorTopN + 最近实例。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3 / quality-metrics.ts:getAgentRuntimeDetail。
 */
monitorRouter.get("/agents/:definitionId/detail", async (c) => {
  const definitionId = c.req.param("definitionId");
  const windowStart = c.req.query("windowStart");
  const windowEnd = c.req.query("windowEnd");
  const input: Parameters<typeof getAgentRuntimeDetail>[1] = {};
  if (windowStart) input.windowStart = windowStart;
  if (windowEnd) input.windowEnd = windowEnd;
  const data = await getAgentRuntimeDetail(definitionId, input);
  if (!data.definition) {
    return c.json({ ok: false, error: "agent definition not found", definitionId }, 404);
  }
  return c.json({ ok: true, data });
});

/**
 * Skills 维度聚合（窗口内按 skill 聚合成功率 / 平均分等）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.4 / runtime/monitor/skills-summary.ts。
 */
monitorRouter.get("/skills/summary", async (c) => {
  const windowMinutes = c.req.query("windowMinutes");
  const sessionId = c.req.query("sessionId");
  const input: Parameters<typeof getSkillsSummary>[0] = {};
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (sessionId) input.sessionId = sessionId;
  const data = await getSkillsSummary(input);
  return c.json({ ok: true, data });
});

/**
 * 失败列表（summary level，跨 tool / mcp / skill / agent）。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.2 与 runtime/monitor/failure-list.ts。
 */
monitorRouter.get("/failures", async (c) => {
  const scopeRaw = c.req.query("scope");
  const allowed: FailureScope[] = ["tool", "mcp", "skill", "agent"];
  const windowMinutes = c.req.query("windowMinutes");
  const limit = c.req.query("limit");
  const sessionId = c.req.query("sessionId");
  /**
   * 与同文件其它路由的模式保持一致：用条件构造避免显式传 undefined
   * （tsconfig 启用 exactOptionalPropertyTypes，传 undefined 会触发 TS2379）。
   */
  const input: Parameters<typeof listFailures>[0] = {};
  if (scopeRaw && (allowed as string[]).includes(scopeRaw)) {
    input.scope = scopeRaw as FailureScope;
  }
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (limit) input.limit = Number(limit);
  if (sessionId) input.sessionId = sessionId;
  const data = await listFailures(input);
  return c.json({ ok: true, data });
});

/**
 * 工具维度聚合 — /tools/summary。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.2 与 runtime/monitor/tools-summary.ts。
 */
monitorRouter.get("/tools/summary", async (c) => {
  const windowMinutes = c.req.query("windowMinutes");
  const sessionId = c.req.query("sessionId");
  const toolKindRaw = c.req.query("toolKind");
  const allowedKinds: ToolKind[] = ["acp_connector", "mcp", "skill", "builtin"];
  const input: Parameters<typeof getToolsSummary>[0] = {};
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (sessionId) input.sessionId = sessionId;
  if (toolKindRaw && (allowedKinds as string[]).includes(toolKindRaw)) {
    input.toolKind = toolKindRaw as ToolKind;
  }
  const data = await getToolsSummary(input);
  return c.json({ ok: true, data });
});

/**
 * MCP 维度聚合 — /mcp/summary。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.3 与 runtime/monitor/mcp-summary.ts。
 */
monitorRouter.get("/mcp/summary", async (c) => {
  const windowMinutes = c.req.query("windowMinutes");
  const sessionId = c.req.query("sessionId");
  const input: Parameters<typeof getMcpSummary>[0] = {};
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (sessionId) input.sessionId = sessionId;
  const data = await getMcpSummary(input);
  return c.json({ ok: true, data });
});

/**
 * 单一 tool 排障详情 — /tools/:toolName/detail。
 *
 * 用于"工具/MCP 排障 tab"右侧详情面板：给定 toolName 返回该工具窗口内的
 * summary + latency 分位 + recent calls + error top + sandbox 阻断分类。
 * toolKind 可选，避免同名工具（如 builtin / mcp 都叫 "search"）混计。
 *
 * 详见 src/runtime/monitor/tools-diagnostics.ts。
 */
monitorRouter.get("/tools/:toolName/detail", async (c) => {
  const toolName = c.req.param("toolName");
  const windowMinutes = c.req.query("windowMinutes");
  const sessionId = c.req.query("sessionId");
  const toolKindRaw = c.req.query("toolKind");
  const recentLimit = c.req.query("recentLimit");
  const errorTopLimit = c.req.query("errorTopLimit");
  const allowedKinds: ToolKind[] = ["acp_connector", "mcp", "skill", "builtin"];
  const input: Parameters<typeof getToolDiagnostics>[0] = { toolName };
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (sessionId) input.sessionId = sessionId;
  if (recentLimit) input.recentLimit = Number(recentLimit);
  if (errorTopLimit) input.errorTopLimit = Number(errorTopLimit);
  if (toolKindRaw && (allowedKinds as string[]).includes(toolKindRaw)) {
    input.toolKind = toolKindRaw as ToolKind;
  }
  const data = await getToolDiagnostics(input);
  return c.json({ ok: true, data });
});

/**
 * 单一 MCP server 排障详情 — /mcp/:serverName/detail。
 * 详见 src/runtime/monitor/mcp-diagnostics.ts。
 */
monitorRouter.get("/mcp/:serverName/detail", async (c) => {
  const serverName = c.req.param("serverName");
  const windowMinutes = c.req.query("windowMinutes");
  const sessionId = c.req.query("sessionId");
  const recentLimit = c.req.query("recentLimit");
  const errorTopLimit = c.req.query("errorTopLimit");
  const input: Parameters<typeof getMcpDiagnostics>[0] = { serverName };
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (sessionId) input.sessionId = sessionId;
  if (recentLimit) input.recentLimit = Number(recentLimit);
  if (errorTopLimit) input.errorTopLimit = Number(errorTopLimit);
  const data = await getMcpDiagnostics(input);
  return c.json({ ok: true, data });
});

/**
 * LLM 用量聚合 — /llm/usage。
 * 详见 docs/MONITORING_V2_DESIGN.md §4.1.1 / §7.5 与 runtime/monitor/llm-usage.ts。
 */
monitorRouter.get("/llm/usage", async (c) => {
  const windowMinutes = c.req.query("windowMinutes");
  const sessionId = c.req.query("sessionId");
  const input: Parameters<typeof getLlmUsageSummary>[0] = {};
  if (windowMinutes) input.windowMinutes = Number(windowMinutes);
  if (sessionId) input.sessionId = sessionId;
  const data = await getLlmUsageSummary(input);
  return c.json({ ok: true, data });
});

monitorRouter.post("/alerts/workflows/:id/trigger", async (c) => {
  const workflowId = c.req.param("id");
  const data = await createAlertsFromWorkflowQuality(workflowId);
  return c.json({ ok: true, data });
});

monitorRouter.get("/alerts", async (c) => {
  const scopeType = c.req.query("scopeType") as "workflow" | "agent" | "system" | undefined;
  const scopeId = c.req.query("scopeId");
  const status = c.req.query("status") as "open" | "ack" | "resolved" | undefined;
  const limit = c.req.query("limit");
  const data = await listAlerts({
    scopeType,
    scopeId,
    status,
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ ok: true, data });
});

monitorRouter.post("/alerts/:id/ack", async (c) => {
  const alertId = c.req.param("id");
  const data = await ackAlert(alertId);
  if (!data) return c.json({ ok: false, error: "alert not found" }, 404);
  return c.json({ ok: true, data });
});

monitorRouter.post("/alerts/:id/resolve", async (c) => {
  const alertId = c.req.param("id");
  const data = await resolveAlert(alertId);
  if (!data) return c.json({ ok: false, error: "alert not found" }, 404);
  return c.json({ ok: true, data });
});

monitorRouter.post("/alerts/resolve-by-scope", async (c) => {
  const body = await c.req
    .json<{ scopeType?: "workflow" | "agent" | "system"; scopeId?: string }>()
    .catch(() => ({}));
  if (!body.scopeType || !body.scopeId) {
    return c.json({ ok: false, error: "scopeType and scopeId required" }, 400);
  }
  const data = await resolveAlertsByScope(body.scopeType, body.scopeId);
  return c.json({ ok: true, data });
});

monitorRouter.get("/eval/datasets", async (c) => {
  const data = await listEvalDatasets();
  return c.json({ ok: true, data });
});

monitorRouter.post("/eval/datasets", async (c) => {
  const body = await c.req
    .json<{
      name?: string;
      version?: string;
      scenario?: string;
      sourceDesc?: string;
      metaJson?: Record<string, unknown>;
    }>()
    .catch(() => ({}));
  if (!body.name) return c.json({ ok: false, error: "name is required" }, 400);
  const data = await createEvalDataset({
    name: body.name,
    version: body.version,
    scenario: body.scenario,
    sourceDesc: body.sourceDesc,
    metaJson: body.metaJson,
  });
  return c.json({ ok: true, data });
});

monitorRouter.post("/eval/runs", async (c) => {
  const body = await c.req
    .json<{
      datasetId?: string;
      caseCount?: number;
      toggle?: { msa?: boolean; sdp?: boolean; rfv?: boolean };
      baselineToggle?: { msa?: boolean; sdp?: boolean; rfv?: boolean };
    }>()
    .catch(() => ({}));
  if (!body.datasetId) return c.json({ ok: false, error: "datasetId is required" }, 400);
  const data = await runEval({
    datasetId: body.datasetId,
    caseCount: body.caseCount,
    toggle: body.toggle,
    baselineToggle: body.baselineToggle,
  });
  return c.json({ ok: true, data });
});

monitorRouter.get("/eval/runs", async (c) => {
  const datasetId = c.req.query("datasetId");
  const data = await listEvalRuns(datasetId);
  return c.json({ ok: true, data });
});

monitorRouter.get("/eval/runs/:id", async (c) => {
  const runId = c.req.param("id");
  const data = await getEvalRunDetail(runId);
  return c.json({ ok: true, data });
});
