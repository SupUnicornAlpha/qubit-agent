import { randomUUID } from "node:crypto";
import { gte } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { connectorCallLog } from "../../db/sqlite/schema";

export type ConnectorCallOperation = "init" | "healthcheck" | "execute" | "shutdown";
export type ConnectorCallStatus = "success" | "error" | "timeout";

export type ConnectorCallSummary = {
  connectorName: string;
  operation: ConnectorCallOperation;
  totalCalls: number;
  successCount: number;
  errorCount: number;
  timeoutCount: number;
  successRate: number;
  avgLatencyMs: number | null;
  lastError: string | null;
  lastCalledAt: string | null;
};

function summarizeValue(value: unknown, depth = 0): unknown {
  if (depth > 2 || value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return `[string:${value.length}]`;
  if (typeof value === "number" || typeof value === "boolean") return typeof value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  if (typeof value === "object") {
    return {
      type: "object",
      keys: Object.keys(value as Record<string, unknown>).slice(0, 40),
    };
  }
  return typeof value;
}

export async function recordConnectorCall(input: {
  connectorName: string;
  operation: ConnectorCallOperation;
  traceId?: string;
  workflowRunId?: string | null;
  request?: unknown;
  response?: unknown;
  latencyMs: number;
  status: ConnectorCallStatus;
  errorMessage?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.insert(connectorCallLog).values({
    id: randomUUID(),
    connectorName: input.connectorName,
    workflowRunId: input.workflowRunId ?? null,
    traceId: input.traceId?.trim() || randomUUID(),
    operation: input.operation,
    requestJson: summarizeValue(input.request),
    responseJson: input.response === undefined ? null : summarizeValue(input.response),
    latencyMs: Math.max(0, Math.round(input.latencyMs)),
    status: input.status,
    errorMessage: input.errorMessage?.slice(0, 1_000) ?? null,
  });
}

export async function getConnectorCallSummary(input?: {
  windowMinutes?: number;
}): Promise<ConnectorCallSummary[]> {
  const db = await getDb();
  const requestedWindow = input?.windowMinutes ?? 24 * 60;
  const windowMinutes = Number.isFinite(requestedWindow)
    ? Math.max(1, Math.min(7 * 24 * 60, Math.round(requestedWindow)))
    : 24 * 60;
  const since = new Date(Date.now() - windowMinutes * 60 * 1_000).toISOString();
  const rows = await db
    .select({
      connectorName: connectorCallLog.connectorName,
      operation: connectorCallLog.operation,
      status: connectorCallLog.status,
      latencyMs: connectorCallLog.latencyMs,
      errorMessage: connectorCallLog.errorMessage,
      createdAt: connectorCallLog.createdAt,
    })
    .from(connectorCallLog)
    .where(gte(connectorCallLog.createdAt, since));

  type Acc = {
    connectorName: string;
    operation: ConnectorCallOperation;
    totalCalls: number;
    successCount: number;
    errorCount: number;
    timeoutCount: number;
    latencySum: number;
    latencyCount: number;
    lastError: string | null;
    lastCalledAt: string | null;
  };
  const grouped = new Map<string, Acc>();
  for (const row of rows) {
    const operation = row.operation as ConnectorCallOperation;
    const key = `${row.connectorName}::${operation}`;
    const current = grouped.get(key) ?? {
      connectorName: row.connectorName,
      operation,
      totalCalls: 0,
      successCount: 0,
      errorCount: 0,
      timeoutCount: 0,
      latencySum: 0,
      latencyCount: 0,
      lastError: null,
      lastCalledAt: null,
    };
    current.totalCalls += 1;
    if (row.status === "success") current.successCount += 1;
    else if (row.status === "timeout") current.timeoutCount += 1;
    else current.errorCount += 1;
    if (typeof row.latencyMs === "number") {
      current.latencySum += row.latencyMs;
      current.latencyCount += 1;
    }
    if (row.errorMessage && (!current.lastError || row.createdAt >= (current.lastCalledAt ?? ""))) {
      current.lastError = row.errorMessage;
    }
    if (!current.lastCalledAt || row.createdAt > current.lastCalledAt) {
      current.lastCalledAt = row.createdAt;
    }
    grouped.set(key, current);
  }

  return [...grouped.values()]
    .map((row) => ({
      connectorName: row.connectorName,
      operation: row.operation,
      totalCalls: row.totalCalls,
      successCount: row.successCount,
      errorCount: row.errorCount,
      timeoutCount: row.timeoutCount,
      successRate: Number((row.successCount / row.totalCalls).toFixed(4)),
      avgLatencyMs:
        row.latencyCount > 0 ? Number((row.latencySum / row.latencyCount).toFixed(2)) : null,
      lastError: row.lastError,
      lastCalledAt: row.lastCalledAt,
    }))
    .sort((a, b) => b.totalCalls - a.totalCalls);
}
