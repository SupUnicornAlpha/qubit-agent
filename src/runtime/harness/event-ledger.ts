import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { harnessEventLedger, toolCallLog } from "../../db/sqlite/schema";

export type HarnessEventType =
  | "capability.composed"
  | "capability.degraded"
  | "tool.admitted"
  | "tool.rejected"
  | "tool.started"
  | "tool.completed"
  | "artifact.created";

export type HarnessEvent = {
  id: string;
  workflowRunId: string;
  traceId: string | null;
  turnId: string | null;
  stepId: string | null;
  toolCallId: string | null;
  capabilityId: string | null;
  profileId: string | null;
  dedupeKey: string | null;
  schemaVersion: number;
  eventType: HarnessEventType;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type HarnessTraceProjection = {
  events: HarnessEvent[];
  summary: {
    composed: number;
    degraded: number;
    admitted: number;
    rejected: number;
    started: number;
    completed: number;
    artifacts: number;
    completedByStatus: Record<string, number>;
  };
};

const MAX_EVENT_PAYLOAD_BYTES = 12 * 1024;
const SECRET_KEY = /(?:api[_-]?key|authorization|token|password|secret|cookie|credential)/i;
let warnedUnavailable = false;

export function redactHarnessEventPayload(value: Record<string, unknown>): Record<string, unknown> {
  const redact = (candidate: unknown, depth = 0): unknown => {
    if (depth > 5) return "[depth-truncated]";
    if (Array.isArray(candidate))
      return candidate.slice(0, 40).map((item) => redact(item, depth + 1));
    if (!candidate || typeof candidate !== "object") {
      return typeof candidate === "string" && candidate.length > 2_000
        ? `${candidate.slice(0, 2_000)}…[truncated]`
        : candidate;
    }
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>)
        .slice(0, 80)
        .map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : redact(item, depth + 1)])
    );
  };
  const redacted = redact(value) as Record<string, unknown>;
  let serialized = "";
  try {
    serialized = JSON.stringify(redacted);
  } catch {
    return { summary: "unserializable event payload", truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_EVENT_PAYLOAD_BYTES) return redacted;
  return {
    summary: `event payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} bytes`,
    keys: Object.keys(redacted).slice(0, 40),
    truncated: true,
  };
}

export async function appendHarnessEvent(input: {
  workflowRunId: string;
  eventType: HarnessEventType;
  traceId?: string | null;
  turnId?: string | null;
  stepId?: string | null;
  toolCallId?: string | null;
  capabilityId?: string | null;
  profileId?: string | null;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
}): Promise<HarnessEvent | null> {
  const db = await getDb();
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const payload = redactHarnessEventPayload(input.payload ?? {});
  await db
    .insert(harnessEventLedger)
    .values({
      id,
      workflowRunId: input.workflowRunId,
      traceId: input.traceId ?? null,
      turnId: input.turnId ?? null,
      stepId: input.stepId ?? null,
      toolCallId: input.toolCallId ?? null,
      capabilityId: input.capabilityId ?? null,
      profileId: input.profileId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      schemaVersion: 1,
      eventType: input.eventType,
      payloadJson: payload,
      createdAt,
    })
    .onConflictDoNothing();
  if (input.dedupeKey) {
    const rows = await db
      .select()
      .from(harnessEventLedger)
      .where(eq(harnessEventLedger.id, id))
      .limit(1);
    return rows[0] ? toHarnessEvent(rows[0]) : null;
  }
  return {
    id,
    workflowRunId: input.workflowRunId,
    traceId: input.traceId ?? null,
    turnId: input.turnId ?? null,
    stepId: input.stepId ?? null,
    toolCallId: input.toolCallId ?? null,
    capabilityId: input.capabilityId ?? null,
    profileId: input.profileId ?? null,
    dedupeKey: input.dedupeKey ?? null,
    schemaVersion: 1,
    eventType: input.eventType,
    payload,
    createdAt,
  };
}

/** A missing migration must never break an already-running workflow. */
export async function appendHarnessEventSafe(
  input: Parameters<typeof appendHarnessEvent>[0]
): Promise<HarnessEvent | null> {
  try {
    return await appendHarnessEvent(input);
  } catch (error) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        `[harness-event-ledger] append skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }
}

export async function appendHarnessEventForToolCallSafe(input: {
  toolCallId: string;
  eventType: Extract<HarnessEventType, "tool.admitted" | "tool.rejected" | "tool.completed">;
  payload?: Record<string, unknown>;
}): Promise<HarnessEvent | null> {
  try {
    const db = await getDb();
    const rows = await db
      .select({
        workflowRunId: toolCallLog.workflowRunId,
        traceId: toolCallLog.traceId,
        stepId: toolCallLog.agentStepId,
        toolName: toolCallLog.toolName,
        toolKind: toolCallLog.toolKind,
        status: toolCallLog.status,
      })
      .from(toolCallLog)
      .where(eq(toolCallLog.id, input.toolCallId))
      .limit(1);
    const row = rows[0];
    if (!row?.workflowRunId) return null;
    return appendHarnessEventSafe({
      workflowRunId: row.workflowRunId,
      traceId: row.traceId,
      stepId: row.stepId,
      toolCallId: input.toolCallId,
      eventType: input.eventType,
      payload: {
        toolName: row.toolName,
        toolKind: row.toolKind,
        status: row.status,
        ...(input.payload ?? {}),
      },
    });
  } catch (error) {
    if (!warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        `[harness-event-ledger] tool projection skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return null;
  }
}

/**
 * Records the resolved composition once per workflow and effective profile set.
 * A unique ledger key makes repeatedly resolving a prompt surface inexpensive.
 */
export async function appendHarnessCompositionSafe(input: {
  workflowRunId: string;
  mode?: "shadow" | "active";
  profileIds: readonly string[];
  capabilityIds: readonly string[];
  sharedTools: readonly string[];
  legacyOnlyTools: readonly string[];
  harnessOnlyTools: readonly string[];
}): Promise<HarnessEvent | null> {
  const profileIds = [...new Set(input.profileIds)].sort();
  const capabilityIds = [...new Set(input.capabilityIds)].sort();
  const mode = input.mode ?? "shadow";
  if (profileIds.length === 0 && capabilityIds.length === 0) return null;
  const profileId = profileIds.join("+") || "unprofiled";
  return appendHarnessEventSafe({
    workflowRunId: input.workflowRunId,
    eventType: "capability.composed",
    profileId,
    dedupeKey: `composition:v1:${mode}:${profileId}:${capabilityIds.join(",")}`,
    payload: {
      mode,
      profileIds,
      capabilityIds,
      sharedTools: [...input.sharedTools],
      legacyOnlyTools: [...input.legacyOnlyTools],
      harnessOnlyTools: [...input.harnessOnlyTools],
    },
  });
}

export async function listHarnessTraceProjection(
  workflowRunId: string,
  limit = 200
): Promise<HarnessTraceProjection> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(harnessEventLedger)
      .where(eq(harnessEventLedger.workflowRunId, workflowRunId))
      .orderBy(asc(harnessEventLedger.createdAt), asc(harnessEventLedger.id))
      .limit(Math.max(1, Math.min(1_000, limit)));
    return projectHarnessTrace(rows.map(toHarnessEvent));
  } catch {
    return projectHarnessTrace([]);
  }
}

export async function listRecentHarnessEvents(limit = 50): Promise<HarnessEvent[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(harnessEventLedger)
    .orderBy(desc(harnessEventLedger.createdAt), desc(harnessEventLedger.id))
    .limit(Math.max(1, Math.min(500, limit)));
  return rows.map(toHarnessEvent);
}

export function projectHarnessTrace(events: readonly HarnessEvent[]): HarnessTraceProjection {
  const completedByStatus: Record<string, number> = {};
  for (const event of events) {
    if (event.eventType !== "tool.completed") continue;
    const status = typeof event.payload.status === "string" ? event.payload.status : "unknown";
    completedByStatus[status] = (completedByStatus[status] ?? 0) + 1;
  }
  const count = (eventType: HarnessEventType) =>
    events.filter((event) => event.eventType === eventType).length;
  return {
    events: [...events],
    summary: {
      composed: count("capability.composed"),
      degraded: count("capability.degraded"),
      admitted: count("tool.admitted"),
      rejected: count("tool.rejected"),
      started: count("tool.started"),
      completed: count("tool.completed"),
      artifacts: count("artifact.created"),
      completedByStatus,
    },
  };
}

function toHarnessEvent(row: typeof harnessEventLedger.$inferSelect): HarnessEvent {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    traceId: row.traceId,
    turnId: row.turnId,
    stepId: row.stepId,
    toolCallId: row.toolCallId,
    capabilityId: row.capabilityId,
    profileId: row.profileId,
    dedupeKey: row.dedupeKey,
    schemaVersion: row.schemaVersion,
    eventType: row.eventType as HarnessEventType,
    payload: asRecord(row.payloadJson),
    createdAt: row.createdAt,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
