import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  alertEvent,
  agentInstance,
  workflowQualitySnapshot,
  workflowRun,
} from "../../db/sqlite/schema";

const DEFAULT_STUCK_MINUTES = 120;

export async function getMonitorSummary(input?: {
  sessionId?: string;
  stuckMinutes?: number;
}) {
  const db = await getDb();
  const stuckMinutes = input?.stuckMinutes ?? DEFAULT_STUCK_MINUTES;
  const stuckBefore = new Date(Date.now() - stuckMinutes * 60 * 1000).toISOString();

  let workflows = await db.select().from(workflowRun).orderBy(desc(workflowRun.startedAt));
  if (input?.sessionId) {
    workflows = workflows.filter((w) => w.sessionId === input.sessionId);
  }
  const recent = workflows.slice(0, 500);

  const statusCounts: Record<string, number> = {};
  for (const w of recent) {
    const key = w.status ?? "unknown";
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
  }

  const running = recent.filter((w) => w.status === "running");
  const stuckRunning = running.filter((w) => w.startedAt && w.startedAt < stuckBefore);

  const workflowIds = recent.map((w) => w.id);
  const snapshots =
    workflowIds.length > 0
      ? await db
          .select()
          .from(workflowQualitySnapshot)
          .where(inArray(workflowQualitySnapshot.workflowRunId, workflowIds))
          .orderBy(desc(workflowQualitySnapshot.createdAt))
      : [];

  const latestSnapshotByWorkflow = new Map<string, (typeof snapshots)[number]>();
  for (const snap of snapshots) {
    if (!latestSnapshotByWorkflow.has(snap.workflowRunId)) {
      latestSnapshotByWorkflow.set(snap.workflowRunId, snap);
    }
  }
  const latestScores = [...latestSnapshotByWorkflow.values()].map((s) => s.qualityScore);
  const avgQualityScore =
    latestScores.length > 0
      ? Number((latestScores.reduce((a, b) => a + b, 0) / latestScores.length).toFixed(4))
      : null;

  const alerts = await db
    .select()
    .from(alertEvent)
    .where(eq(alertEvent.status, "open"))
    .orderBy(desc(alertEvent.createdAt))
    .limit(200);

  const instances =
    workflowIds.length > 0
      ? await db
          .select()
          .from(agentInstance)
          .where(inArray(agentInstance.workflowRunId, workflowIds.slice(0, 100)))
      : [];
  const instanceErrors = instances.filter((i) => i.status === "error").length;

  const window24hStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const completed24h = recent.filter(
    (w) =>
      w.status === "completed" &&
      w.endedAt &&
      w.endedAt >= window24hStart
  ).length;
  const failed24h = recent.filter(
    (w) => w.status === "failed" && w.endedAt && w.endedAt >= window24hStart
  ).length;

  return {
    sessionId: input?.sessionId ?? null,
    workflowTotal: recent.length,
    statusCounts,
    running: statusCounts.running ?? 0,
    failed: statusCounts.failed ?? 0,
    completed24h,
    failed24h,
    stuckRunning: stuckRunning.map((w) => ({
      id: w.id,
      sessionId: w.sessionId,
      mode: w.mode,
      startedAt: w.startedAt,
      goal: w.goal?.slice(0, 120) ?? null,
    })),
    openAlerts: alerts.length,
    recentAlerts: alerts.slice(0, 10),
    avgQualityScore,
    snapshotCount: snapshots.length,
    instanceErrors,
    stuckThresholdMinutes: stuckMinutes,
  };
}

export async function scanStuckWorkflows(stuckMinutes = DEFAULT_STUCK_MINUTES) {
  const db = await getDb();
  const stuckBefore = new Date(Date.now() - stuckMinutes * 60 * 1000).toISOString();
  const rows = await db
    .select()
    .from(workflowRun)
    .where(and(eq(workflowRun.status, "running"), lt(workflowRun.startedAt, stuckBefore)))
    .orderBy(workflowRun.startedAt)
    .limit(50);
  return rows;
}
