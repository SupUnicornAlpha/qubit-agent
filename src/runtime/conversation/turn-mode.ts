/**
 * Session / Turn 原语类型（docs/agent-contracts/06-session-turn-protocol.md）
 */

export type ConversationTurnMode = "new_goal" | "continue_goal";

export function normalizeTurnMode(raw: unknown): ConversationTurnMode | undefined {
  if (raw === "new_goal" || raw === "continue_goal") return raw;
  return undefined;
}

/**
 * 兼容旧字段 → turnMode。
 * - 显式 turnMode 优先
 * - reuseSessionWorkflow=false → new_goal（同一 workflow 内重置目标/上下文，不再新建 workflow）
 * - preserveGoal=true → continue_goal
 * - 默认 continue_goal
 */
export function resolveTurnMode(input: {
  turnMode?: unknown;
  reuseSessionWorkflow?: boolean;
  preserveGoal?: boolean;
  hasWorkflowRunId?: boolean;
}): ConversationTurnMode {
  const explicit = normalizeTurnMode(input.turnMode);
  if (explicit) return explicit;
  if (input.preserveGoal === true) return "continue_goal";
  if (input.reuseSessionWorkflow === false) return "new_goal";
  if (input.hasWorkflowRunId) return "continue_goal";
  if (input.reuseSessionWorkflow === true) return "continue_goal";
  // 缺省：chat 创建路径允许复用 session active run
  return "continue_goal";
}
