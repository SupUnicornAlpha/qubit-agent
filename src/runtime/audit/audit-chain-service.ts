import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { DbClient } from "../../db/sqlite/client";
import { auditLog } from "../../db/sqlite/schema";

const auditChainQueues = new Map<string, Promise<void>>();

async function withAuditChainLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = auditChainQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  auditChainQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (auditChainQueues.get(key) === queued) auditChainQueues.delete(key);
  }
}

export interface AuditChainEntry {
  id: string;
  traceId: string;
  workflowRunId: string | null;
  agentInstanceId: string | null;
  actorType: "agent" | "user" | "system";
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detailJson: unknown;
  previousHash: string | null;
  entryHash: string | null;
  createdAt: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function computeAuditEntryHash(entry: Omit<AuditChainEntry, "entryHash">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(entry))).digest("hex");
}

export function verifyAuditEntries(entries: AuditChainEntry[]): {
  valid: boolean;
  sealedEntries: number;
  legacyUnsealedEntries: number;
  firstInvalidId: string | null;
  reason: string | null;
  headHash: string | null;
} {
  let expectedPrevious: string | null = null;
  let sealedEntries = 0;
  let legacyUnsealedEntries = 0;
  for (const entry of entries) {
    if (!entry.entryHash) {
      legacyUnsealedEntries += 1;
      continue;
    }
    if (entry.previousHash !== expectedPrevious) {
      return {
        valid: false, sealedEntries, legacyUnsealedEntries, firstInvalidId: entry.id,
        reason: "previous_hash_mismatch", headHash: expectedPrevious,
      };
    }
    const { entryHash, ...hashInput } = entry;
    if (computeAuditEntryHash(hashInput) !== entryHash) {
      return {
        valid: false, sealedEntries, legacyUnsealedEntries, firstInvalidId: entry.id,
        reason: "entry_hash_mismatch", headHash: expectedPrevious,
      };
    }
    expectedPrevious = entryHash;
    sealedEntries += 1;
  }
  return {
    valid: true,
    sealedEntries,
    legacyUnsealedEntries,
    firstInvalidId: null,
    reason: null,
    headHash: expectedPrevious,
  };
}

export async function appendAuditLog(
  db: DbClient,
  input: {
    id?: string;
    traceId: string;
    workflowRunId?: string | null;
    agentInstanceId?: string | null;
    actorType: "agent" | "user" | "system";
    actorId: string;
    action: string;
    resourceType: string;
    resourceId: string;
    detailJson: Record<string, unknown>;
    createdAt?: string;
  },
): Promise<AuditChainEntry> {
  const chainKey = input.workflowRunId
    ? `workflow:${input.workflowRunId}`
    : `trace:${input.traceId}`;
  return withAuditChainLock(chainKey, async () => {
    const previousRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          input.workflowRunId
            ? eq(auditLog.workflowRunId, input.workflowRunId)
            : eq(auditLog.traceId, input.traceId),
          isNotNull(auditLog.entryHash),
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(1);
    const requestedCreatedAt = input.createdAt ?? new Date().toISOString();
    const previousCreatedAt = previousRows[0]?.createdAt;
    const createdAt = previousCreatedAt && requestedCreatedAt <= previousCreatedAt
      ? new Date(new Date(previousCreatedAt).getTime() + 1).toISOString()
      : requestedCreatedAt;
    const entry: AuditChainEntry = {
      id: input.id ?? randomUUID(),
      traceId: input.traceId,
      workflowRunId: input.workflowRunId ?? null,
      agentInstanceId: input.agentInstanceId ?? null,
      actorType: input.actorType,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      detailJson: input.detailJson,
      previousHash: previousRows[0]?.entryHash ?? null,
      entryHash: null,
      createdAt,
    };
    const { entryHash: _entryHash, ...hashInput } = entry;
    entry.entryHash = computeAuditEntryHash(hashInput);
    await db.insert(auditLog).values(entry);
    return entry;
  });
}

export async function verifyAuditLogChain(
  db: DbClient,
  input: { workflowRunId?: string; traceId?: string },
) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(
      input.workflowRunId
        ? eq(auditLog.workflowRunId, input.workflowRunId)
        : input.traceId
          ? eq(auditLog.traceId, input.traceId)
          : undefined,
    )
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
  return { ...verifyAuditEntries(rows as AuditChainEntry[]), totalEntries: rows.length };
}
