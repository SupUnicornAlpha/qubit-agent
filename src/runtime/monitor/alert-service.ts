import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { alertEvent, workflowQualitySnapshot } from "../../db/sqlite/schema";

function deriveSeverity(qualityScore: number, errorCount: number): "warn" | "error" | "critical" {
  if (errorCount >= 5 || qualityScore < 0.35) return "critical";
  if (errorCount >= 2 || qualityScore < 0.55) return "error";
  return "warn";
}

export async function createAlertsFromWorkflowQuality(workflowId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(workflowQualitySnapshot)
    .where(eq(workflowQualitySnapshot.workflowRunId, workflowId))
    .orderBy(desc(workflowQualitySnapshot.createdAt))
    .limit(1);
  const snapshot = rows[0];
  if (!snapshot) throw new Error("workflow quality snapshot not found");

  const shouldAlert = snapshot.errorCount > 0 || snapshot.qualityScore < 0.75;
  if (!shouldAlert) return [];
  const severity = deriveSeverity(snapshot.qualityScore, snapshot.errorCount);
  const id = randomUUID();
  await db.insert(alertEvent).values({
    id,
    scopeType: "workflow",
    scopeId: workflowId,
    alertType: "workflow_quality_degraded",
    severity,
    title: `Workflow quality degraded (${workflowId})`,
    detailsJson: {
      qualityScore: snapshot.qualityScore,
      errorCount: snapshot.errorCount,
      sandboxBlockCount: snapshot.sandboxBlockCount,
      totalToolCalls: snapshot.totalToolCalls,
      snapshotId: snapshot.id,
    },
    status: "open",
  });
  return db.select().from(alertEvent).where(eq(alertEvent.id, id));
}

export async function listAlerts(input?: {
  scopeType?: "workflow" | "agent" | "system";
  scopeId?: string;
  status?: "open" | "ack" | "resolved";
}) {
  const db = await getDb();
  const rows = await db.select().from(alertEvent).orderBy(desc(alertEvent.createdAt));
  return rows.filter((row) => {
    if (input?.scopeType && row.scopeType !== input.scopeType) return false;
    if (input?.scopeId && row.scopeId !== input.scopeId) return false;
    if (input?.status && row.status !== input.status) return false;
    return true;
  });
}

export async function ackAlert(alertId: string) {
  const db = await getDb();
  await db.update(alertEvent).set({ status: "ack" }).where(eq(alertEvent.id, alertId));
  const rows = await db.select().from(alertEvent).where(eq(alertEvent.id, alertId)).limit(1);
  return rows[0] ?? null;
}

export async function resolveAlert(alertId: string) {
  const db = await getDb();
  await db
    .update(alertEvent)
    .set({ status: "resolved", resolvedAt: new Date().toISOString() })
    .where(eq(alertEvent.id, alertId));
  const rows = await db.select().from(alertEvent).where(eq(alertEvent.id, alertId)).limit(1);
  return rows[0] ?? null;
}

export async function resolveAlertsByScope(scopeType: "workflow" | "agent" | "system", scopeId: string) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(alertEvent)
    .where(and(eq(alertEvent.scopeType, scopeType), eq(alertEvent.scopeId, scopeId), eq(alertEvent.status, "open")));
  for (const row of rows) {
    await db
      .update(alertEvent)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(eq(alertEvent.id, row.id));
  }
  return { resolved: rows.length };
}
