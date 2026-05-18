import { desc, eq, inArray } from "drizzle-orm";
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
  aggregateAgentRuntimeMetrics,
  createWorkflowQualitySnapshot,
  listAgentRuntimeMetrics,
  listWorkflowQualitySnapshots,
} from "../runtime/monitor/quality-metrics";
import {
  ackAlert,
  createAlertsFromWorkflowQuality,
  createStuckWorkflowAlerts,
  listAlerts,
  resolveAlert,
  resolveAlertsByScope,
} from "../runtime/monitor/alert-service";
import { getMonitorSummary } from "../runtime/monitor/monitor-summary";
import {
  createEvalDataset,
  getEvalRunDetail,
  listEvalDatasets,
  listEvalRuns,
  runEval,
} from "../runtime/eval/pipeline";

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
  const toolsByStep = new Map<string, (typeof tools)>();
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
    workflows.map((w) => [w.id, { startedAt: w.startedAt, status: w.status, mode: w.mode }] as const)
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
    db.select().from(a2aMessage).orderBy(desc(a2aMessage.createdAt)).limit(limit * 4),
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

monitorRouter.get("/workflows", async (c) => {
  const db = await getDb();
  const sessionId = c.req.query("sessionId");
  const status = c.req.query("status");
  const mode = c.req.query("mode");
  const rows = await db.select().from(workflowRun).orderBy(desc(workflowRun.startedAt));
  const filtered = rows.filter((item) => {
    if (sessionId && item.sessionId !== sessionId) return false;
    if (status && item.status !== status) return false;
    if (mode && item.mode !== mode) return false;
    return true;
  });
  return c.json({ data: filtered.slice(0, 200) });
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
  const body = await c.req
    .json<{ windowStart?: string; windowEnd?: string }>()
    .catch(() => ({}));
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
