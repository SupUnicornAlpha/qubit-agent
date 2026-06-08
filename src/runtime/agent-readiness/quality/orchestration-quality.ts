/**
 * D 类 · 编排质量。
 *
 *   D-2 步数效率：max(step_index)+1 / max_iterations。1 = 触顶（红）
 *   D-3 reason+act 时间占比 = SUM(latency_ms WHERE phase IN ('reason','act')) / SUM(latency_ms)
 *
 * 设计取舍：
 *   - D-1 (终态分布) 已在 thresholds.MUST_HAVE_THRESHOLDS 里以 O-1 名字保留，本文件不重复实现
 *   - D-2 用 max(step_index)+1 而非 count(*)，因为可能存在重试（同一 index 被覆盖时计 1）
 *   - D-3 取 reason+act 占比表达"思考+做事"的有效时间，越高越好
 */
import type { Database } from "bun:sqlite";

export interface OrchestrationQualityResult {
  "D-2": number | null;
  "D-3": number | null;
  details: {
    maxStepIndex: number | null;
    maxIterations: number | null;
    phaseLatencyMs: Record<string, number>;
  };
}

export async function collectOrchestrationQuality(
  sqlite: Database,
  workflowRunId: string
): Promise<OrchestrationQualityResult> {
  // D-2：找该 workflow 下所有 instance 的 max(step_index)+1，与他们的 max_iterations 比
  const stepRow = sqlite
    .prepare(
      `SELECT MAX(step_index) AS maxIdx, COUNT(*) AS cnt
       FROM agent_step WHERE workflow_run_id = ?`
    )
    .get(workflowRunId) as { maxIdx: number | null; cnt: number };
  const maxStepIndex = stepRow.maxIdx;

  // 取该 workflow 下任一 agent_instance 的 max_iterations（同 workflow 多 agent 时取 max）
  const itRow = sqlite
    .prepare(
      `SELECT MAX(ad.max_iterations) AS maxIt
       FROM agent_instance ai
       JOIN agent_definition ad ON ad.id = ai.definition_id
       WHERE ai.workflow_run_id = ?`
    )
    .get(workflowRunId) as { maxIt: number | null };
  const maxIterations = itRow.maxIt;

  let d2: number | null = null;
  if (maxStepIndex != null && maxIterations != null && maxIterations > 0) {
    d2 = Math.min(1, (maxStepIndex + 1) / maxIterations);
  }

  // D-3：reason+act 时间 / 总时间
  const phases = sqlite
    .prepare(
      `SELECT phase, COALESCE(SUM(latency_ms), 0) AS total
       FROM agent_step WHERE workflow_run_id = ? GROUP BY phase`
    )
    .all(workflowRunId) as Array<{ phase: string; total: number }>;
  const phaseLatencyMs: Record<string, number> = {};
  let total = 0;
  let reasonAct = 0;
  for (const p of phases) {
    phaseLatencyMs[p.phase] = Number(p.total);
    total += Number(p.total);
    if (p.phase === "reason" || p.phase === "act") reasonAct += Number(p.total);
  }
  const d3 = total > 0 ? reasonAct / total : null;

  return {
    "D-2": d2,
    "D-3": d3,
    details: {
      maxStepIndex,
      maxIterations,
      phaseLatencyMs,
    },
  };
}
