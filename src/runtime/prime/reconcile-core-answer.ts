/**
 * Final-answer guard for Prime Core turns.
 *
 * A turn may contain an early failure observation and then recover through a
 * later strategy composition/backtest.  The LLM's prose is generated from its
 * turn context and can otherwise retain the early "not closed" conclusion
 * even though the durable execution records say the workflow completed.
 */
import { getRuntimeSqlite } from "../policy/repositories/runtime-sqlite";

export type WorkflowExecutionSummary = {
  completedBacktestIds: string[];
  factorEvaluationCount: number;
  strategyCompositionCount: number;
};

function count(sql: string, workflowId: string): number {
  try {
    const row = getRuntimeSqlite().prepare(sql).get(workflowId) as { c?: unknown } | undefined;
    return Math.max(0, Number(row?.c ?? 0));
  } catch {
    return 0;
  }
}

/** Read only durable records that are relevant to a quantitative closure. */
export function loadWorkflowExecutionSummary(workflowId: string): WorkflowExecutionSummary {
  try {
    const sqlite = getRuntimeSqlite();
    const rows = sqlite
      .prepare(
        `SELECT id
         FROM backtest_run
         WHERE workflow_run_id = ? AND status = 'completed'
         ORDER BY coalesce(ended_at, created_at) DESC
         LIMIT 3`
      )
      .all(workflowId) as Array<{ id?: unknown }>;
    return {
      completedBacktestIds: rows
        .map((row) => (typeof row.id === "string" ? row.id : ""))
        .filter(Boolean),
      factorEvaluationCount: count(
        `SELECT COUNT(*) AS c
         FROM factor_evaluation fe
         JOIN factor_definition fd ON fd.id = fe.factor_id
         WHERE fd.workflow_run_id = ? AND coalesce(fe.error, '') = ''`,
        workflowId
      ),
      strategyCompositionCount: count(
        "SELECT COUNT(*) AS c FROM strategy_composition WHERE workflow_run_id = ?",
        workflowId
      ),
    };
  } catch {
    return {
      completedBacktestIds: [],
      factorEvaluationCount: 0,
      strategyCompositionCount: 0,
    };
  }
}

const STALE_QUANT_CLOSURE_CLAIM =
  /(?:无法闭环|验证未发生|未闭环|全部\s*\[数据缺口\]|步骤\s*3[^\n]*❌)/u;

/**
 * Prefer durable artifacts over stale natural-language claims.  We retain the
 * original report for auditability and put the correction first, so a user
 * never acts on an invalid "backtest did not run" statement.
 */
export function reconcileCoreAnswerWithExecutionSummary(
  answerText: string,
  summary: WorkflowExecutionSummary
): string {
  const text = answerText.trim();
  if (!text || summary.completedBacktestIds.length === 0 || !STALE_QUANT_CLOSURE_CLAIM.test(text)) {
    return text;
  }

  const completed = summary.completedBacktestIds.length;
  const ids = summary.completedBacktestIds.map((id) => `\`${id.slice(0, 8)}\``).join("、");
  const extras = [
    summary.factorEvaluationCount > 0 ? `因子评估 ${summary.factorEvaluationCount} 条` : "",
    summary.strategyCompositionCount > 0 ? `策略组合 ${summary.strategyCompositionCount} 个` : "",
  ]
    .filter(Boolean)
    .join("；");
  const detail = extras ? `；${extras}` : "";

  return [
    `> **系统执行记录补正**：本轮已成功完成 ${completed} 次回测（${ids}）${detail}。`,
    "> 下方“无法闭环 / 验证未发生 / 数据缺口”等描述来自恢复前的早期失败观察，已被后续成功产物覆盖；请以回测产物与其绩效字段为准。",
    "",
    text,
  ].join("\n");
}

/** Load artifacts and reconcile a Core answer without making final delivery depend on the guard. */
export function reconcileCoreAnswerWithWorkflowArtifacts(
  workflowId: string,
  answerText: string
): string {
  return reconcileCoreAnswerWithExecutionSummary(
    answerText,
    loadWorkflowExecutionSummary(workflowId)
  );
}
