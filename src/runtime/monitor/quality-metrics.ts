import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentDefinition,
  agentInstance,
  agentRuntimeMetric,
  agentStep,
  sandboxViolationLog,
  toolCallLog,
  workflowQualitySnapshot,
  workflowRun,
} from "../../db/sqlite/schema";

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

export function calcQualityScore(input: {
  totalToolCalls: number;
  sandboxBlockCount: number;
  errorCount: number;
}): number {
  const toolPenalty = Math.min(0.4, input.totalToolCalls * 0.005);
  const sandboxPenalty = Math.min(0.3, input.sandboxBlockCount * 0.08);
  const errorPenalty = Math.min(0.6, input.errorCount * 0.12);
  return Math.max(0, Number((1 - toolPenalty - sandboxPenalty - errorPenalty).toFixed(4)));
}

export async function createWorkflowQualitySnapshot(workflowId: string) {
  const db = await getDb();
  const [workflowRows, steps, instances, violations] = await Promise.all([
    db.select().from(workflowRun).where(eq(workflowRun.id, workflowId)).limit(1),
    db.select().from(agentStep).where(eq(agentStep.workflowRunId, workflowId)),
    db.select().from(agentInstance).where(eq(agentInstance.workflowRunId, workflowId)),
    db.select().from(sandboxViolationLog).where(eq(sandboxViolationLog.workflowRunId, workflowId)),
  ]);
  const workflow = workflowRows[0];
  if (!workflow) throw new Error("workflow not found");

  const stepIds = steps.map((s) => s.id);
  const toolCalls =
    stepIds.length > 0
      ? await db.select().from(toolCallLog).where(inArray(toolCallLog.agentStepId, stepIds))
      : [];
  const sandboxBlockCount = toolCalls.filter((t) => t.status === "sandbox_blocked").length;
  const timeoutCount = toolCalls.filter((t) => t.status === "timeout").length;
  const toolErrorCount = toolCalls.filter((t) => t.status === "error").length;
  const instanceErrorCount = instances.filter((i) => i.status === "error").length;
  const errorCount = violations.length + toolErrorCount + timeoutCount + instanceErrorCount;

  const startedAtMs = workflow.startedAt ? Date.parse(workflow.startedAt) : NaN;
  const endedAtMs = workflow.endedAt ? Date.parse(workflow.endedAt) : Date.now();
  const totalDurationMs = Number.isFinite(startedAtMs) ? Math.max(0, endedAtMs - startedAtMs) : null;

  const qualityScore = calcQualityScore({
    totalToolCalls: toolCalls.length,
    sandboxBlockCount,
    errorCount,
  });

  const id = randomUUID();
  await db.insert(workflowQualitySnapshot).values({
    id,
    workflowRunId: workflowId,
    totalDurationMs,
    totalToolCalls: toolCalls.length,
    sandboxBlockCount,
    errorCount,
    qualityScore,
  });
  const row = await db.select().from(workflowQualitySnapshot).where(eq(workflowQualitySnapshot.id, id)).limit(1);
  return row[0];
}

export async function listWorkflowQualitySnapshots(workflowId: string) {
  const db = await getDb();
  return db
    .select()
    .from(workflowQualitySnapshot)
    .where(eq(workflowQualitySnapshot.workflowRunId, workflowId))
    .orderBy(desc(workflowQualitySnapshot.createdAt));
}

export async function aggregateAgentRuntimeMetrics(input?: {
  windowStart?: string;
  windowEnd?: string;
}) {
  const db = await getDb();
  const now = new Date();
  const windowEnd = input?.windowEnd ?? now.toISOString();
  const windowStart =
    input?.windowStart ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [instances, steps, tools, definitions] = await Promise.all([
    db
      .select()
      .from(agentInstance)
      .where(and(gte(agentInstance.startedAt, windowStart), lte(agentInstance.startedAt, windowEnd))),
    db
      .select()
      .from(agentStep)
      .where(and(gte(agentStep.createdAt, windowStart), lte(agentStep.createdAt, windowEnd))),
    db
      .select()
      .from(toolCallLog)
      .where(and(gte(toolCallLog.createdAt, windowStart), lte(toolCallLog.createdAt, windowEnd))),
    db.select().from(agentDefinition),
  ]);

  const defById = new Map(definitions.map((d) => [d.id, d]));
  const stepsByInstance = new Map<string, (typeof steps)>();
  for (const step of steps) {
    const bucket = stepsByInstance.get(step.agentInstanceId) ?? [];
    bucket.push(step);
    stepsByInstance.set(step.agentInstanceId, bucket);
  }
  const toolsByStep = new Map<string, (typeof tools)>();
  for (const tool of tools) {
    const bucket = toolsByStep.get(tool.agentStepId) ?? [];
    bucket.push(tool);
    toolsByStep.set(tool.agentStepId, bucket);
  }

  const metricsByDefinition = new Map<
    string,
    {
      runCount: number;
      successCount: number;
      errorCount: number;
      timeoutCount: number;
      latencies: number[];
      tokenSum: number;
      tokenCount: number;
    }
  >();

  for (const instance of instances) {
    const key = instance.definitionId;
    const metric =
      metricsByDefinition.get(key) ??
      {
        runCount: 0,
        successCount: 0,
        errorCount: 0,
        timeoutCount: 0,
        latencies: [],
        tokenSum: 0,
        tokenCount: 0,
      };
    metric.runCount += 1;
    if (instance.status === "error") metric.errorCount += 1;
    else if (instance.status === "stopped") metric.successCount += 1;
    const instanceSteps = stepsByInstance.get(instance.id) ?? [];
    for (const step of instanceSteps) {
      if (typeof step.tokenCount === "number") {
        metric.tokenSum += step.tokenCount;
        metric.tokenCount += 1;
      }
      const calls = toolsByStep.get(step.id) ?? [];
      for (const call of calls) {
        if (typeof call.latencyMs === "number") metric.latencies.push(call.latencyMs);
        if (call.status === "timeout") metric.timeoutCount += 1;
        if (call.status === "error") metric.errorCount += 1;
      }
    }
    metricsByDefinition.set(key, metric);
  }

  const insertedIds: string[] = [];
  for (const [definitionId, m] of metricsByDefinition) {
    const id = randomUUID();
    insertedIds.push(id);
    await db.insert(agentRuntimeMetric).values({
      id,
      definitionId,
      windowStart,
      windowEnd,
      runCount: m.runCount,
      successCount: m.successCount,
      errorCount: m.errorCount,
      timeoutCount: m.timeoutCount,
      p50LatencyMs: percentile(m.latencies, 50),
      p95LatencyMs: percentile(m.latencies, 95),
      avgTokenCount: m.tokenCount > 0 ? Number((m.tokenSum / m.tokenCount).toFixed(2)) : null,
    });
  }

  const rows = insertedIds.length
    ? await db
        .select()
        .from(agentRuntimeMetric)
        .where(and(gte(agentRuntimeMetric.windowStart, windowStart), lte(agentRuntimeMetric.windowEnd, windowEnd)))
        .orderBy(desc(agentRuntimeMetric.createdAt))
    : [];
  return rows.map((row) => ({
    ...row,
    role: defById.get(row.definitionId)?.role ?? "unknown",
    name: defById.get(row.definitionId)?.name ?? "unknown",
  }));
}

export async function listAgentRuntimeMetrics(input?: {
  windowStart?: string;
  windowEnd?: string;
}) {
  const db = await getDb();
  const now = new Date();
  const windowEnd = input?.windowEnd ?? now.toISOString();
  const windowStart =
    input?.windowStart ?? new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const definitions = await db.select().from(agentDefinition);
  const defById = new Map(definitions.map((d) => [d.id, d]));
  const rows = await db
    .select()
    .from(agentRuntimeMetric)
    .where(and(gte(agentRuntimeMetric.windowStart, windowStart), lte(agentRuntimeMetric.windowEnd, windowEnd)))
    .orderBy(desc(agentRuntimeMetric.createdAt));
  return rows.map((row) => ({
    ...row,
    role: defById.get(row.definitionId)?.role ?? "unknown",
    name: defById.get(row.definitionId)?.name ?? "unknown",
  }));
}
