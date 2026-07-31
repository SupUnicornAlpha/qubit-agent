import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowArtifactLedger } from "../../db/sqlite/schema";
import type { DataGap } from "./data-gap";
import { resolveToolCallCachePolicy } from "./tool-call-dedup";

export type WorkflowArtifactKind =
  | "SymbolResolution"
  | "MarketSnapshot"
  | "FundamentalSnapshot"
  | "NewsEvidence"
  | "FactorInventory"
  | "Recommendation"
  | "DataGap";

export type WorkflowArtifact = {
  id: string;
  workflowRunId: string;
  fingerprint: string;
  kind: WorkflowArtifactKind;
  toolName: string;
  payload: Record<string, unknown>;
  producerTaskId: string | null;
  asOf: string | null;
  freshnessMs: number | null;
  expiresAt: string | null;
  createdAt: string;
};

const MAX_PAYLOAD_BYTES = 24 * 1024;

export function classifyWorkflowArtifactKind(toolName: string): WorkflowArtifactKind | null {
  const tool = toolName.toLowerCase().split("/").at(-1) ?? toolName.toLowerCase();
  if (/resolve_symbol/.test(tool)) return "SymbolResolution";
  if (/fetch_(?:fundamentals|financial_data)|fetch_earnings|fetch_dividends/.test(tool)) {
    return "FundamentalSnapshot";
  }
  if (/fetch_(?:quote|ticks|klines|bars)|get_quote|fetch_price_data/.test(tool)) {
    return "MarketSnapshot";
  }
  if (/news|sentiment|filing/.test(tool)) return "NewsEvidence";
  if (/factor\.list|list_factors/.test(tool)) return "FactorInventory";
  if (/recommendation\.record|record_recommendation/.test(tool)) return "Recommendation";
  return null;
}

export async function recordWorkflowToolArtifact(input: {
  workflowRunId: string;
  fingerprint: string;
  toolName: string;
  result: Record<string, unknown>;
  producerTaskId?: string | null;
}): Promise<WorkflowArtifact | null> {
  const kind = classifyWorkflowArtifactKind(input.toolName);
  if (!kind) return null;
  const now = new Date();
  const payload = compactPayload(input.result);
  const metadata = findTemporalMetadata(payload);
  const policy = resolveToolCallCachePolicy(input.toolName);
  const expiresAt = Number.isFinite(policy.ttlMs)
    ? new Date(now.getTime() + policy.ttlMs).toISOString()
    : null;
  const db = await getDb();
  const id = randomUUID();
  const nowIso = now.toISOString();
  await db
    .insert(workflowArtifactLedger)
    .values({
      id,
      workflowRunId: input.workflowRunId,
      fingerprint: input.fingerprint,
      artifactKind: kind,
      toolName: input.toolName,
      payloadJson: payload,
      producerTaskId: input.producerTaskId ?? null,
      asOf: metadata.asOf,
      freshnessMs: metadata.freshnessMs,
      expiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: [workflowArtifactLedger.workflowRunId, workflowArtifactLedger.fingerprint],
      set: {
        artifactKind: kind,
        toolName: input.toolName,
        payloadJson: payload,
        producerTaskId: input.producerTaskId ?? null,
        asOf: metadata.asOf,
        freshnessMs: metadata.freshnessMs,
        expiresAt,
        updatedAt: nowIso,
      },
    });
  return findWorkflowArtifactByFingerprint(input.workflowRunId, input.fingerprint, now);
}

/** Persist a known data gap so A2A re-dispatch does not retry an impossible request. */
export async function recordWorkflowDataGap(input: {
  workflowRunId: string;
  fingerprint: string;
  toolName: string;
  gap: DataGap;
  producerTaskId?: string | null;
}): Promise<WorkflowArtifact | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt =
    input.gap.kind === "transient"
      ? new Date(now.getTime() + 60_000).toISOString()
      : input.gap.kind === "no_data"
        ? new Date(now.getTime() + 5 * 60_000).toISOString()
        : null;
  const db = await getDb();
  await db
    .insert(workflowArtifactLedger)
    .values({
      id: randomUUID(),
      workflowRunId: input.workflowRunId,
      fingerprint: input.fingerprint,
      artifactKind: "DataGap",
      toolName: input.toolName,
      payloadJson: { dataGap: input.gap },
      producerTaskId: input.producerTaskId ?? null,
      asOf: null,
      freshnessMs: null,
      expiresAt,
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: [workflowArtifactLedger.workflowRunId, workflowArtifactLedger.fingerprint],
      set: {
        artifactKind: "DataGap",
        toolName: input.toolName,
        payloadJson: { dataGap: input.gap },
        producerTaskId: input.producerTaskId ?? null,
        asOf: null,
        freshnessMs: null,
        expiresAt,
        updatedAt: nowIso,
      },
    });
  return findWorkflowArtifactByFingerprint(input.workflowRunId, input.fingerprint, now);
}

/** Returns only non-expired durable facts. */
export async function findWorkflowArtifactByFingerprint(
  workflowRunId: string,
  fingerprint: string,
  now = new Date()
): Promise<WorkflowArtifact | null> {
  try {
    const db = await getDb();
    const rows = await db
      .select()
      .from(workflowArtifactLedger)
      .where(
        and(
          eq(workflowArtifactLedger.workflowRunId, workflowRunId),
          eq(workflowArtifactLedger.fingerprint, fingerprint),
          or(
            isNull(workflowArtifactLedger.expiresAt),
            gt(workflowArtifactLedger.expiresAt, now.toISOString())
          )
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      workflowRunId: row.workflowRunId,
      fingerprint: row.fingerprint,
      kind: row.artifactKind as WorkflowArtifactKind,
      toolName: row.toolName,
      payload: asRecord(row.payloadJson),
      producerTaskId: row.producerTaskId,
      asOf: row.asOf,
      freshnessMs: row.freshnessMs,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
    };
  } catch (error) {
    // Deployments rolling forward before migration 0100 must keep executing;
    // they simply cannot reuse cross-run evidence until migration completes.
    console.warn(
      `[workflow-artifact-ledger] lookup skipped: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

/** Bounded final-answer reference set; payloads stay in the ledger, not agent_step. */
export async function listWorkflowArtifactReferences(
  workflowRunId: string,
  limit = 20
): Promise<Array<Pick<WorkflowArtifact, "id" | "kind" | "toolName" | "asOf" | "freshnessMs">>> {
  const db = await getDb();
  const rows = await db
    .select({
      id: workflowArtifactLedger.id,
      artifactKind: workflowArtifactLedger.artifactKind,
      toolName: workflowArtifactLedger.toolName,
      asOf: workflowArtifactLedger.asOf,
      freshnessMs: workflowArtifactLedger.freshnessMs,
    })
    .from(workflowArtifactLedger)
    .where(eq(workflowArtifactLedger.workflowRunId, workflowRunId))
    .orderBy(desc(workflowArtifactLedger.createdAt))
    .limit(Math.max(1, Math.min(50, limit)));
  return rows.map((row) => ({
    id: row.id,
    kind: row.artifactKind as WorkflowArtifactKind,
    toolName: row.toolName,
    asOf: row.asOf,
    freshnessMs: row.freshnessMs,
  }));
}

/**
 * Typed, bounded facts for the next Reason turn. This deliberately reads the
 * durable ledger rather than past Markdown summaries, so A2A/retry can reason
 * from the same market/fundamental/news/recommendation facts as final delivery.
 */
export async function listWorkflowArtifactsForContext(
  workflowRunId: string,
  limit = 8
): Promise<WorkflowArtifact[]> {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowArtifactLedger)
    .where(
      and(
        eq(workflowArtifactLedger.workflowRunId, workflowRunId),
        or(
          isNull(workflowArtifactLedger.expiresAt),
          gt(workflowArtifactLedger.expiresAt, new Date().toISOString())
        )
      )
    )
    .orderBy(desc(workflowArtifactLedger.createdAt))
    .limit(Math.max(1, Math.min(16, limit)));
  return rows.map((row) => ({
    id: row.id,
    workflowRunId: row.workflowRunId,
    fingerprint: row.fingerprint,
    kind: row.artifactKind as WorkflowArtifactKind,
    toolName: row.toolName,
    payload: asRecord(row.payloadJson),
    producerTaskId: row.producerTaskId,
    asOf: row.asOf,
    freshnessMs: row.freshnessMs,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }));
}

export function renderWorkflowArtifactContext(artifacts: readonly WorkflowArtifact[]): string {
  if (artifacts.length === 0) return "";
  return [
    "## 已验证结构化证据（Artifact Ledger）",
    ...artifacts.map((artifact) => {
      const payload = JSON.stringify(artifact.payload).slice(0, 1_200);
      return `- [${artifact.kind}] tool=${artifact.toolName}; asOf=${artifact.asOf ?? "unknown"}; freshnessMs=${artifact.freshnessMs ?? "unknown"}; payload=${payload}`;
    }),
    "只能据此引用已验证事实；不要把它改写成尚未执行的工具结果。",
  ].join("\n");
}

function compactPayload(value: Record<string, unknown>): Record<string, unknown> {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { summary: String(value).slice(0, 2_000), truncated: true };
  }
  if (Buffer.byteLength(serialized, "utf8") <= MAX_PAYLOAD_BYTES) return value;
  return {
    summary: summarizePayload(value),
    truncated: true,
  };
}

function summarizePayload(value: Record<string, unknown>): string {
  const candidates = [
    value.connectorResult,
    value.mcpResult,
    value.builtinResult,
    value.analystTeamResult,
    value,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return `array result (${candidate.length} items); original payload exceeds ledger limit`;
    }
    if (candidate && typeof candidate === "object") {
      return `object result keys: ${Object.keys(candidate as Record<string, unknown>)
        .slice(0, 20)
        .join(", ")}`;
    }
  }
  return String(value).slice(0, 2_000);
}

function findTemporalMetadata(payload: Record<string, unknown>): {
  asOf: string | null;
  freshnessMs: number | null;
} {
  const scan = (
    value: unknown,
    depth = 0
  ): { asOf: string | null; freshnessMs: number | null } | null => {
    if (!value || typeof value !== "object" || depth > 4) return null;
    if (Array.isArray(value)) {
      for (const item of value.slice(-5)) {
        const found = scan(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    const record = value as Record<string, unknown>;
    const asOf =
      [record.asOf, record.asof, record.timestamp, record.time].find(
        (item): item is string => typeof item === "string" && item.length > 0
      ) ?? null;
    const freshnessMs =
      typeof record.freshnessMs === "number" && Number.isFinite(record.freshnessMs)
        ? record.freshnessMs
        : null;
    if (asOf || freshnessMs !== null) return { asOf, freshnessMs };
    for (const child of Object.values(record).slice(0, 20)) {
      const found = scan(child, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return scan(payload) ?? { asOf: null, freshnessMs: null };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
