/**
 * 工作流展示类型（由 goal / mode / source 等字段推断，无需单独 DB 列）。
 */
export type WorkflowKind =
  | "chat_session"
  | "research_team"
  | "live_trading"
  | "a2a_pool"
  | "backtest"
  | "other";

export const WORKFLOW_KIND_ORDER: WorkflowKind[] = [
  "research_team",
  "live_trading",
  "chat_session",
  "a2a_pool",
  "backtest",
  "other",
];

export const WORKFLOW_KIND_LABEL: Record<WorkflowKind, string> = {
  chat_session: "对话会话",
  research_team: "研究团队",
  live_trading: "实时交易",
  a2a_pool: "A2A 常驻池",
  backtest: "回测",
  other: "其他",
};

export function classifyWorkflow(row: Record<string, unknown>): WorkflowKind {
  const goal = typeof row.goal === "string" ? row.goal.trim() : "";
  const mode = String(row.mode ?? "");
  const source = String(row.source ?? "");
  const executionPath = String(row.executionPath ?? row.execution_path ?? "");

  if (/Long-lived A2A|agent pool instances/i.test(goal)) return "a2a_pool";
  if (executionPath === "a2a" && /pool|A2A/i.test(goal)) return "a2a_pool";

  if (/实时交易|QUBIT 实时交易/i.test(goal)) return "live_trading";
  if (mode === "live") return "live_trading";
  if (mode === "simulation" && /实时交易|trader/i.test(goal)) return "live_trading";

  if (goal.startsWith("研究团队")) {
    return "research_team";
  }

  if (source === "chat") return "chat_session";

  if (mode === "backtest") return "backtest";

  return "other";
}

export function formatWorkflowOptionLabel(row: Record<string, unknown>): string {
  const kind = classifyWorkflow(row);
  const kindLabel = WORKFLOW_KIND_LABEL[kind];
  const goal = typeof row.goal === "string" ? row.goal.trim() : "";
  const status = String(row.status ?? "—");
  const mode = String(row.mode ?? "—");
  const id = String(row.id ?? "");
  const shortId = id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const goalLabel = goal.length > 40 ? `${goal.slice(0, 40)}…` : goal || shortId;
  return `[${kindLabel}] ${goalLabel} · ${status} · ${mode}`;
}

export function groupWorkflowOptions(
  rows: Array<Record<string, unknown>>
): Array<{ kind: WorkflowKind; label: string; rows: Array<Record<string, unknown>> }> {
  const buckets = new Map<WorkflowKind, Array<Record<string, unknown>>>();
  for (const row of rows) {
    const kind = classifyWorkflow(row);
    const list = buckets.get(kind) ?? [];
    list.push(row);
    buckets.set(kind, list);
  }
  const sortByStarted = (a: Record<string, unknown>, b: Record<string, unknown>) => {
    const ta = new Date(String(a.startedAt ?? 0)).getTime();
    const tb = new Date(String(b.startedAt ?? 0)).getTime();
    return tb - ta;
  };
  return WORKFLOW_KIND_ORDER.filter((kind) => buckets.has(kind)).map((kind) => ({
    kind,
    label: WORKFLOW_KIND_LABEL[kind],
    rows: (buckets.get(kind) ?? []).sort(sortByStarted),
  }));
}
