/**
 * Snapshot Collector：从 SQLite 抓取单个 workflow_run 的健康度指标。
 *
 * 设计原则：
 *   - 直接走 raw SQL（绕开 drizzle ORM 的复杂 schema 反射），更稳。
 *   - 16 个 AQM 指标 + 6 个 LEGACY 指标共存，AQM 主指标驱动 grader 评级。
 *   - LEGACY 6 指标（O-1 / T-1 / T-3 / T-6 / S-1 / M-1）保留兼容，让历史 diff 可读。
 *   - LLM-as-Judge（A-3）通过可选 judge client 接入；不传 → 跳过。
 */

import type { Database } from "bun:sqlite";
import { getDb, getSqliteForTesting } from "../../db/sqlite/client";
import { collectContentQuality } from "./quality/content-quality";
import { collectToolQuality } from "./quality/tool-quality";
import { collectLlmQuality } from "./quality/llm-quality";
import { collectOrchestrationQuality } from "./quality/orchestration-quality";
import {
  collectContentJudge,
  type JudgeClient,
} from "./quality/content-judge";
import type { ReadinessSnapshot } from "./grader";
import type { ScenarioRecipe } from "./scenarios";

export interface CollectSnapshotInput {
  workflowRunId: string;
  scenario: ScenarioRecipe["key"];
  /** 可选：传了就跑 A-3 LLM-as-Judge；不传则 A-3 = null */
  judgeClient?: JudgeClient;
  /** 单 workflow 评的 artifact 上限，避免 token 失控（默认 5） */
  judgeMaxArtifacts?: number;
}

interface WorkflowRow {
  id: string;
  projectId: string;
  goal: string;
  status: string;
  createdAt: string;
  endedAt: string | null;
}

function readWorkflow(sqlite: Database, workflowRunId: string): WorkflowRow | null {
  const row = sqlite
    .prepare(
      `SELECT id, project_id AS projectId, goal, status,
              created_at AS createdAt, ended_at AS endedAt
       FROM workflow_run WHERE id = ?`
    )
    .get(workflowRunId) as WorkflowRow | undefined;
  return row ?? null;
}

// ── LEGACY 6 指标（保留以兼容旧 diff / 历史报告） ─────────────────────────

function metricLegacyO1(row: WorkflowRow): number {
  return row.status === "completed" ? 1 : 0;
}

function metricLegacyT1(sqlite: Database, workflowRunId: string): number {
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

function metricLegacyT3(sqlite: Database, workflowRunId: string): number {
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

function metricLegacyT6(sqlite: Database, workflowRunId: string): number {
  const row = sqlite
    .prepare(
      `SELECT COALESCE(SUM(total_tokens), 0) AS sum FROM llm_call_log WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { sum: number };
  return Number(row.sum ?? 0);
}

function metricLegacyS1(sqlite: Database, workflowRunId: string): number | null {
  const row = sqlite
    .prepare(
      `SELECT
         SUM(CASE WHEN executed = 1 THEN 1 ELSE 0 END) AS executed,
         COUNT(*) AS total
       FROM skill_recall_log
       WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { executed: number | null; total: number };
  if (!row.total) return null;
  return (row.executed ?? 0) / row.total;
}

function metricLegacyM1(sqlite: Database, wf: WorkflowRow): number {
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

// ── 主入口 ─────────────────────────────────────────────────────────────────

export async function collectSnapshot(
  input: CollectSnapshotInput
): Promise<ReadinessSnapshot> {
  await getDb();
  const sqlite = getSqliteForTesting();

  const wf = readWorkflow(sqlite, input.workflowRunId);
  if (!wf) {
    throw new Error(
      `[snapshot-collector] workflow_run not found: ${input.workflowRunId}`
    );
  }

  // A 类（无需 LLM 部分）
  const content = await collectContentQuality(sqlite, {
    workflowRunId: input.workflowRunId,
    scenario: input.scenario,
    goal: wf.goal,
  });
  // B 类
  const tools = await collectToolQuality(sqlite, {
    workflowRunId: input.workflowRunId,
    scenario: input.scenario,
  });
  // C 类
  const llm = await collectLlmQuality(sqlite, input.workflowRunId);
  // D 类
  const orch = await collectOrchestrationQuality(sqlite, input.workflowRunId);
  // A-3（可选）
  const judge = input.judgeClient
    ? await collectContentJudge(sqlite, input.judgeClient, {
        workflowRunId: input.workflowRunId,
        scenario: input.scenario,
        ...(input.judgeMaxArtifacts !== undefined
          ? { maxArtifacts: input.judgeMaxArtifacts }
          : {}),
      })
    : { "A-3": null, details: { judged: [], failed: [] } };

  const metrics: Record<string, number | null> = {
    // A 类
    "A-1": content["A-1"],
    "A-2": content["A-2"],
    "A-3": judge["A-3"],
    "A-4": content["A-4"],
    "A-5": content["A-5"],
    // B 类
    "B-1": tools["B-1"],
    "B-2": tools["B-2"],
    "B-3": tools["B-3"],
    "B-7": tools["B-7"],
    // C 类
    "C-1": llm["C-1"],
    "C-2": llm["C-2"],
    "C-3-total": llm["C-3-total"],
    "C-3-p95": llm["C-3-p95"],
    "C-5": llm["C-5"],
    // D 类
    "D-1": metricLegacyO1(wf), // 复用同一个公式，归类成 D 类
    "D-2": orch["D-2"],
    "D-3": orch["D-3"],
    // LEGACY 兼容
    "O-1": metricLegacyO1(wf),
    "T-1": metricLegacyT1(sqlite, input.workflowRunId),
    "T-3": metricLegacyT3(sqlite, input.workflowRunId),
    "T-6": metricLegacyT6(sqlite, input.workflowRunId),
    "S-1": metricLegacyS1(sqlite, input.workflowRunId),
    "M-1": metricLegacyM1(sqlite, wf),
  };

  return {
    workflowRunId: input.workflowRunId,
    scenario: input.scenario,
    capturedAt: new Date().toISOString(),
    workflowStatus: wf.status,
    metrics,
    quality: {
      content: content.details,
      tools: tools.details,
      llm: llm.details,
      orchestration: orch.details,
      judge: judge.details,
    },
  };
}
