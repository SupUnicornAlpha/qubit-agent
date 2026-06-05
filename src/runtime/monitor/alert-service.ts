import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentStep,
  alertEvent,
  analystResearchJob,
  workflowQualitySnapshot,
  workflowRun,
} from "../../db/sqlite/schema";
import { setWorkflowState } from "../workflow/workflow-state-machine";
import { failAnalystResearchJob } from "../msa/analyst-research-jobs";
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

/**
 * 2026-06-05 监控复盘 #3 P1 修复：workflow stuck watchdog（强制 cancel）。
 *
 * 实测 strategy-chain-NVDA workflow 在 mcp-financex/get_quote 调用失败后
 * 进入 step 3 reason，但 LLM 流式 API 挂起（gateway.ts `consumeResponsesStream`
 * 的 `for await (const ev of readSseEvents(body))` 在 server 不再 push 数据
 * 时永远 pending，且 fetchWithTimeout 的 timer 在 fetch() 返回 Response 后
 * 已经被 clearTimeout 失效，stream-level idle 没保护）。
 * 该工作流卡死 37+ 分钟，无任何 agent_step/tool_call/llm_call_log 推进，
 * 现有 `createStuckWorkflowAlerts(120)` 也只起 alert 不杀。
 *
 * 这里加 watchdog：扫 status='running' 且**最近 N 分钟无 agent_step 推进**
 * 的 workflow → 强制 failed + fail 配套的 analyst_research_job。
 *
 * 与 createStuckWorkflowAlerts 互补：
 *   - createStuckWorkflowAlerts(120)：以 started_at 算总寿命，警告长时跑（正常 case）
 *   - cancelInactiveWorkflows(20)：以 last agent_step.created_at 算"是否还有动静"
 *     专门杀挂死 workflow，阈值更短（默认 20 min）
 *
 * 注意：用 agent_step 而不是 tool_call_log 判活，因为 reason / observe 阶段也
 * 会写 agent_step，但不会调工具 —— 用 tool_call 判活会误杀正在做 LLM
 * reasoning 的工作流。
 */
export async function cancelInactiveWorkflows(maxIdleMinutes = 20) {
  const db = await getDb();
  const idleBeforeMs = Date.now() - maxIdleMinutes * 60 * 1000;
  const idleBeforeIso = new Date(idleBeforeMs).toISOString();

  // 候选 = running 且 (last agent_step 早于阈值 OR 完全无 agent_step 但 startedAt 早于阈值)
  const candidates = await db
    .select({
      id: workflowRun.id,
      startedAt: workflowRun.startedAt,
      lastStepAt: sql<string | null>`(
        SELECT MAX(${agentStep.createdAt}) FROM ${agentStep} WHERE ${agentStep.workflowRunId}=${workflowRun.id}
      )`,
    })
    .from(workflowRun)
    .where(eq(workflowRun.status, "running"))
    .limit(100);

  const cancelled: Array<{ workflowId: string; idleMs: number; reason: string }> = [];
  for (const wf of candidates) {
    const refTs = wf.lastStepAt ?? wf.startedAt;
    if (!refTs) continue;
    const refMs = Date.parse(refTs);
    if (!Number.isFinite(refMs)) continue;
    if (refMs >= idleBeforeMs) continue;

    const idleMs = Date.now() - refMs;
    const idleMinutes = Math.round(idleMs / 60_000);
    const reason = wf.lastStepAt
      ? `stuck_no_progress: last agent_step ${idleMinutes}min ago > ${maxIdleMinutes}min threshold`
      : `stuck_no_progress: no agent_step since startedAt ${idleMinutes}min ago`;

    // 1) workflow_run → failed
    try {
      await setWorkflowState(wf.id, "failed", { reason: `watchdog:${reason}` });
    } catch (e) {
      console.warn(`[cancelInactiveWorkflows] setWorkflowState failed for ${wf.id}: ${(e as Error).message}`);
      continue;
    }

    // 2) 配套 analyst_research_job 也 fail（avoid HITL UI 一直转圈）
    try {
      const activeJobs = await db
        .select({ id: analystResearchJob.id })
        .from(analystResearchJob)
        .where(
          and(
            eq(analystResearchJob.workflowRunId, wf.id),
            inArray(analystResearchJob.status, ["running", "awaiting_approval"])
          )
        );
      for (const j of activeJobs) {
        await failAnalystResearchJob(j.id, new Error(reason));
      }
    } catch (e) {
      console.warn(
        `[cancelInactiveWorkflows] failAnalystResearchJob failed for workflow ${wf.id}: ${(e as Error).message}`
      );
    }

    // 3) 起 alert 留痕（去重：同 workflow + workflow_stuck 只 1 条 open）
    try {
      const existing = await findOpenAlert("workflow", wf.id, "workflow_stuck");
      if (!existing) {
        await db.insert(alertEvent).values({
          id: randomUUID(),
          scopeType: "workflow",
          scopeId: wf.id,
          alertType: "workflow_stuck",
          severity: "error",
          title: `Workflow watchdog cancelled (${wf.id.slice(0, 8)}…)`,
          detailsJson: {
            reason,
            idleMs,
            maxIdleMinutes,
            lastStepAt: wf.lastStepAt,
            startedAt: wf.startedAt,
          },
          status: "open",
        });
      }
    } catch (e) {
      console.warn(`[cancelInactiveWorkflows] alert insert failed for ${wf.id}: ${(e as Error).message}`);
    }

    cancelled.push({ workflowId: wf.id, idleMs, reason });
    console.warn(`[cancelInactiveWorkflows] cancelled workflow=${wf.id} ${reason}`);
  }

  return { scanned: candidates.length, cancelled: cancelled.length, details: cancelled };
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
