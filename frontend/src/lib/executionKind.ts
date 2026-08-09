/**
 * Prime Core ExecutionKind：配置中心展示与新建默认推导。
 * Core 只按此字段分支；legacy role 仅为业务标签。
 */

export type ExecutionKind = "primary" | "subagent" | "reactor";

export const EXECUTION_KIND_OPTIONS: Array<{
  value: ExecutionKind;
  label: string;
  hint: string;
}> = [
  {
    value: "primary",
    label: "主会话 (primary)",
    hint: "对用户开会话、派单与 HITL 的入口 Agent",
  },
  {
    value: "subagent",
    label: "专家子代理 (subagent)",
    hint: "被 primary / 编排 invoke 的专家",
  },
  {
    value: "reactor",
    label: "事件反应器 (reactor)",
    hint: "由行情/新闻等事件唤醒，而非用户直聊",
  },
];

const PRIMARY_ROLES = new Set(["orchestrator", "portfolio_manager"]);
/** Trigger-only defaults; research news_event is a subagent (invoke/call_team). */
const REACTOR_ROLES = new Set<string>([]);

export function executionKindForRole(role: string): ExecutionKind {
  if (PRIMARY_ROLES.has(role)) return "primary";
  if (REACTOR_ROLES.has(role)) return "reactor";
  return "subagent";
}

export function resolveExecutionKind(input: {
  executionKind?: string | null;
  role?: string | null;
}): ExecutionKind {
  const k = input.executionKind?.trim();
  if (k === "primary" || k === "subagent" || k === "reactor") return k;
  if (input.role?.trim()) return executionKindForRole(input.role.trim());
  return "subagent";
}

export function executionKindLabel(kind: ExecutionKind): string {
  return EXECUTION_KIND_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}
