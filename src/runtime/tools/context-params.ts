/**
 * context-params.ts — harness 强制注入的「上下文绑定参数」单一事实源（治理 #2）。
 *
 * 背景：
 *   projectId / project_id / workflowRunId 这类参数不是「业务参数」，而是
 *   harness 从 workflow_run / toolCtx 就能确定的**上下文绑定参数**。让 LLM 去填
 *   只会出问题：实测 LLM 会传占位符（`<ctx.projectId>` / `default`）、业务化乱填
 *   （`nvda_research`）、或干脆漏传，导致 act 阶段要靠 `isLikelyProjectIdFormat`
 *   正向白名单去"猜哪些值非法、该兜底"——既脆弱又把工具契约弄复杂。
 *
 * 新契约（harness owns the tool contract）：
 *   这些参数由 harness **无条件**从权威上下文（workflow_run.project_id /
 *   state.workflowId）填充，**直接覆盖** LLM 传入的任何值。LLM 不需要、也不应该
 *   提供它们（prompt 里已声明会自动注入，见 tool-call-format.ts）。
 *
 * 与 act 阶段的关系：
 *   act.ts 在 dispatch 前调用 injectContextParams 一次性注入，取代原先
 *   `isLikelyProjectIdFormat` 启发式补丁。builtin handler 内部仍保留 `ctx.projectId`
 *   优先的二级兜底（防旁路直调 dispatchBuiltinTool 的单测），但正常链路已不依赖它。
 */

export interface ContextParamSource {
  /** workflow_run.id —— workflowRunId 的权威值 */
  workflowRunId: string;
  /** workflow_run.project_id —— projectId / project_id 的权威值（可能为空/缺失） */
  projectId?: string | null | undefined;
}

/**
 * 无条件覆盖上下文绑定参数。返回新对象（不原地修改入参）。
 *
 * 规则：
 *   - workflowRunId：始终用 source.workflowRunId（必有值）
 *   - projectId / project_id：source.projectId 非空时覆盖；为空时不写
 *     （让下游 handler 报"缺 project_id"清晰错误，而不是写入空串污染）
 */
export function injectContextParams(
  params: Record<string, unknown>,
  source: ContextParamSource
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params, workflowRunId: source.workflowRunId };
  if (source.projectId) {
    out["projectId"] = source.projectId;
    out["project_id"] = source.projectId;
  }
  return out;
}
