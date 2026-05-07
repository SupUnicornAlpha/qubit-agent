import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentStep,
  sandboxViolationLog,
  toolCallLog,
  workflowRun,
} from "../db/sqlite/schema";

export const monitorRouter = new Hono();

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
  const tools = await db.select().from(toolCallLog);
  const toolsByStep = new Map<string, (typeof tools)>();
  for (const tool of tools) {
    if (!stepIds.includes(tool.agentStepId)) continue;
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
  const [instances, definitions, steps] = await Promise.all([
    db.select().from(agentInstance),
    db.select().from(agentDefinition),
    db.select().from(agentStep).orderBy(desc(agentStep.createdAt)),
  ]);
  const definitionMap = new Map(definitions.map((item) => [item.id, item]));
  const latestStepByInstance = new Map<string, (typeof steps)[number]>();
  for (const step of steps) {
    if (!latestStepByInstance.has(step.agentInstanceId)) {
      latestStepByInstance.set(step.agentInstanceId, step);
    }
  }
  const current = instances.filter((item) => workflowIds.includes(item.workflowRunId));
  return c.json({
    data: {
      sessionId,
      agents: current.map((instance) => {
        const def = definitionMap.get(instance.definitionId);
        const latestStep = latestStepByInstance.get(instance.id);
        return {
          instanceId: instance.id,
          workflowRunId: instance.workflowRunId,
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
  const [workflowRows, instances, steps, tools, violations] = await Promise.all([
    db.select().from(workflowRun).where(eq(workflowRun.id, workflowId)).limit(1),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowId)),
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowId)),
    db.select().from(toolCallLog),
    db.select().from(sandboxViolationLog).where(eq(sandboxViolationLog.workflowRunId, workflowId)),
  ]);
  if (!workflowRows[0]) return c.json({ error: "workflow not found", workflowId }, 404);
  const stepIds = new Set(steps.map((step) => step.id));
  const usedTools = tools.filter((tool) => stepIds.has(tool.agentStepId));
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
