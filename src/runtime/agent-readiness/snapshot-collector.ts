/**
 * Snapshot Collector：从 SQLite 抓取单个 workflow_run 的 6 个 must-have 健康度指标。
 *
 * 设计原则：
 *   - 直接走 raw SQL（绕开 drizzle ORM 的复杂 schema 反射），更稳。
 *   - 每个指标都是"小段 SQL + 简单计算"，避免单条 4-5 join 的庞大 SQL 影响可读性。
 *   - 指标 ID 与 docs/superpowers/specs/2026-06-05-agent-readiness-runner-design.md §2 对应。
 *
 * 6 个 must-have：
 *   O-1：workflow.status === completed → 1，其他 → 0
 *   T-1：tool_call_log error 比例（无调用 → 0）
 *   T-3：mcp_call_log circuit_state=open 比例（分母排除 NULL）
 *   T-6：llm_call_log 总 token 消耗（NULL 不计）
 *   S-1：skill_recall_log executed=1 比例（无召回 → null）
 *   M-1：[startedAt, endedAt] 内对应 project 的 longterm_memory 条数
 */

import type { Database } from "bun:sqlite";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import type { ReadinessSnapshot } from "./grader";

export interface CollectSnapshotInput {
  workflowRunId: string;
  scenario: string;
}

interface WorkflowRow {
  id: string;
  projectId: string;
  status: string;
  /** workflow_run.created_at —— 用作"工作流开始时间" */
  createdAt: string;
  endedAt: string | null;
}

function readWorkflow(sqlite: Database, workflowRunId: string): WorkflowRow | null {
  const row = sqlite
    .prepare(
      "SELECT id, project_id AS projectId, status, created_at AS createdAt, ended_at AS endedAt FROM workflow_run WHERE id = ?"
    )
    .get(workflowRunId) as WorkflowRow | undefined;
  return row ?? null;
}

function metricO1(row: WorkflowRow): number {
  return row.status === "completed" ? 1 : 0;
}

function metricT1(sqlite: Database, workflowRunId: string): number {
  const row = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS err,
         COUNT(*) AS total
       FROM tool_call_log
       WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { err: number | null; total: number };
  if (!row.total) return 0;
  return (row.err ?? 0) / row.total;
}

function metricT3(sqlite: Database, workflowRunId: string): number {
  const row = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN circuit_state = 'open' THEN 1 ELSE 0 END) AS opened,
         SUM(CASE WHEN circuit_state IS NOT NULL THEN 1 ELSE 0 END) AS withState
       FROM mcp_call_log
       WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { opened: number | null; withState: number | null };
  const denom = row.withState ?? 0;
  if (!denom) return 0;
  return (row.opened ?? 0) / denom;
}

function metricT6(sqlite: Database, workflowRunId: string): number {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS sum FROM llm_call_log WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { sum: number };
  return Number(row.sum ?? 0);
}

function metricS1(sqlite: Database, workflowRunId: string): number | null {
  const row = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN executed = 1 THEN 1 ELSE 0 END) AS executed,
         COUNT(*) AS total
       FROM skill_recall_log
       WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { executed: number | null; total: number };
  // 没有任何召回记录 → null（无法判定 vs 0%）
  if (!row.total) return null;
  return (row.executed ?? 0) / row.total;
}

function metricM1(sqlite: Database, wf: WorkflowRow): number {
  // 用 workflow_run.created_at 作下界；没结束用当前时间作上界
  const startedAt = wf.createdAt;
  const endedAt = wf.endedAt ?? new Date().toISOString();
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS c
       FROM longterm_memory
       WHERE scope = 'project'
         AND scope_id = ?
         AND updated_at >= ?
         AND updated_at <= ?`
    )
    .get(wf.projectId, startedAt, endedAt) as { c: number };
  return Number(row.c ?? 0);
}

export async function collectSnapshot(
  input: CollectSnapshotInput
): Promise<ReadinessSnapshot> {
  await getDb(); // ensure connection + PRAGMA
  const sqlite = getSqliteForTesting();

  const wf = readWorkflow(sqlite, input.workflowRunId);
  if (!wf) {
    throw new Error(
      `[snapshot-collector] workflow_run not found: ${input.workflowRunId}`
    );
  }

  const metrics: Record<string, number | null> = {
    "O-1": metricO1(wf),
    "T-1": metricT1(sqlite, input.workflowRunId),
    "T-3": metricT3(sqlite, input.workflowRunId),
    "T-6": metricT6(sqlite, input.workflowRunId),
    "S-1": metricS1(sqlite, input.workflowRunId),
    "M-1": metricM1(sqlite, wf),
  };

  return {
    workflowRunId: input.workflowRunId,
    scenario: input.scenario,
    capturedAt: new Date().toISOString(),
    workflowStatus: wf.status,
    metrics,
  };
}
