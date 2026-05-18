import { randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { alertEvent, workflowQualitySnapshot, workflowRun } from "../../db/sqlite/schema";
import type { WorkflowTerminalStatus } from "./observability-hook";

export function deriveSeverity(
  qualityScore: number,
  errorCount: number
): "warn" | "error" | "critical" {
  if (errorCount >= 5 || qualityScore < 0.35) return "critical";
  if (errorCount >= 2 || qualityScore < 0.55) return "error";
  return "warn";
}

async function findOpenAlert(
  scopeType: "workflow" | "agent" | "system",
  scopeId: string,
  alertType: string
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(alertEvent)
    .where(
      and(
        eq(alertEvent.scopeType, scopeType),
        eq(alertEvent.scopeId, scopeId),
        eq(alertEvent.alertType, alertType),
        eq(alertEvent.status, "open")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function createAlertsFromWorkflowQuality(
  workflowId: string,
  input?: {
    status?: WorkflowTerminalStatus;
    snapshot?: typeof workflowQualitySnapshot.$inferSelect;
  }
) {
  const db = await getDb();
  let snapshot = input?.snapshot;
  if (!snapshot) {
    const rows = await db
      .select()
      .from(workflowQualitySnapshot)
      .where(eq(workflowQualitySnapshot.workflowRunId, workflowId))
      .orderBy(desc(workflowQualitySnapshot.createdAt))
      .limit(1);
    snapshot = rows[0];
  }
  if (!snapshot) throw new Error("workflow quality snapshot not found");

  const created: (typeof alertEvent.$inferSelect)[] = [];

  if (input?.status === "failed") {
    const existingFailed = await findOpenAlert("workflow", workflowId, "workflow_failed");
    if (!existingFailed) {
      const id = randomUUID();
      await db.insert(alertEvent).values({
        id,
        scopeType: "workflow",
        scopeId: workflowId,
        alertType: "workflow_failed",
        severity: "error",
        title: `Workflow failed (${workflowId.slice(0, 8)}…)`,
        detailsJson: {
          snapshotId: snapshot.id,
          qualityScore: snapshot.qualityScore,
          errorCount: snapshot.errorCount,
        },
        status: "open",
      });
      const row = await db.select().from(alertEvent).where(eq(alertEvent.id, id)).limit(1);
      if (row[0]) created.push(row[0]);
    }
  }

  const shouldQualityAlert = snapshot.errorCount > 0 || snapshot.qualityScore < 0.75;
  if (shouldQualityAlert) {
    const existingQuality = await findOpenAlert(
      "workflow",
      workflowId,
      "workflow_quality_degraded"
    );
    if (!existingQuality) {
      const severity = deriveSeverity(snapshot.qualityScore, snapshot.errorCount);
      const id = randomUUID();
      await db.insert(alertEvent).values({
        id,
        scopeType: "workflow",
        scopeId: workflowId,
        alertType: "workflow_quality_degraded",
        severity,
        title: `Workflow quality degraded (${workflowId.slice(0, 8)}…)`,
        detailsJson: {
          qualityScore: snapshot.qualityScore,
          errorCount: snapshot.errorCount,
          sandboxBlockCount: snapshot.sandboxBlockCount,
          totalToolCalls: snapshot.totalToolCalls,
          snapshotId: snapshot.id,
        },
        status: "open",
      });
      const row = await db.select().from(alertEvent).where(eq(alertEvent.id, id)).limit(1);
      if (row[0]) created.push(row[0]);
    }
  }

  return created;
}

export async function createStuckWorkflowAlerts(stuckMinutes = 120) {
  const db = await getDb();
  const stuckBefore = new Date(Date.now() - stuckMinutes * 60 * 1000).toISOString();
  const stuck = await db
    .select()
    .from(workflowRun)
    .where(and(eq(workflowRun.status, "running"), lt(workflowRun.startedAt, stuckBefore)))
    .limit(50);

  const created: string[] = [];
  for (const wf of stuck) {
    const existing = await findOpenAlert("workflow", wf.id, "workflow_stuck");
    if (existing) continue;
    const id = randomUUID();
    await db.insert(alertEvent).values({
      id,
      scopeType: "workflow",
      scopeId: wf.id,
      alertType: "workflow_stuck",
      severity: "warn",
      title: `Workflow stuck in running (${wf.id.slice(0, 8)}…)`,
      detailsJson: {
        startedAt: wf.startedAt,
        stuckMinutes,
        mode: wf.mode,
        sessionId: wf.sessionId,
      },
      status: "open",
    });
    created.push(id);
  }
  return { scanned: stuck.length, created: created.length, alertIds: created };
}

export async function listAlerts(input?: {
  scopeType?: "workflow" | "agent" | "system";
  scopeId?: string;
  status?: "open" | "ack" | "resolved";
  limit?: number;
}) {
  const db = await getDb();
  const limit = Math.max(1, Math.min(500, input?.limit ?? 100));
  const conditions = [];
  if (input?.scopeType) conditions.push(eq(alertEvent.scopeType, input.scopeType));
  if (input?.scopeId) conditions.push(eq(alertEvent.scopeId, input.scopeId));
  if (input?.status) conditions.push(eq(alertEvent.status, input.status));

  const rows =
    conditions.length > 0
      ? await db
          .select()
          .from(alertEvent)
          .where(and(...conditions))
          .orderBy(desc(alertEvent.createdAt))
          .limit(limit)
      : await db.select().from(alertEvent).orderBy(desc(alertEvent.createdAt)).limit(limit);
  return rows;
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

export async function resolveAlertsByScope(
  scopeType: "workflow" | "agent" | "system",
  scopeId: string
) {
  const db = await getDb();
  const rows = await db
    .select()
    .from(alertEvent)
    .where(
      and(
        eq(alertEvent.scopeType, scopeType),
        eq(alertEvent.scopeId, scopeId),
        eq(alertEvent.status, "open")
      )
    );
  for (const row of rows) {
    await db
      .update(alertEvent)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(eq(alertEvent.id, row.id));
  }
  return { resolved: rows.length };
}
