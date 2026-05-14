import type { StepStreamEvent } from "../api/types";

export interface StreamTimelineStep {
  ts: number;
  label: string;
  detail: string;
}

/** 与 `StreamTimelineGroupCard` 的 props 对齐 */
export interface StreamTimelineGroupData {
  workflowRunId: string;
  runId: string;
  at: number;
  firstTs: number;
  roleSummary: string;
  steps: StreamTimelineStep[];
}

type GroupAcc = {
  workflowRunId: string;
  runId: string;
  firstTs: number;
  lastTs: number;
  roles: Set<string>;
  steps: StreamTimelineStep[];
};

/**
 * 将 StepStream 事件按一次运行 (workflowId + runId) 分组，合并连续 token。
 * @param workflowIdFilter 为空或 null 时不过滤；否则只保留集合内的 workflowId。
 */
export function groupStreamEventsByRun(
  streamEvents: StepStreamEvent[],
  workflowIdFilter?: Set<string> | null
): StreamTimelineGroupData[] {
  const filtered =
    !workflowIdFilter || workflowIdFilter.size === 0
      ? streamEvents
      : streamEvents.filter((e) => workflowIdFilter.has(e.workflowId));
  const byTs = [...filtered].sort((a, b) => a.ts - b.ts);

  const groupOrder: string[] = [];
  const groupMap = new Map<string, GroupAcc>();
  const groupKey = (workflowId: string, runId: string) => `${workflowId}::${runId}`;

  const pushStep = (g: GroupAcc, step: StreamTimelineStep) => {
    g.lastTs = step.ts;
    const role = step.label.split(/\s/)[0];
    if (role) g.roles.add(role);
    g.steps.push(step);
  };

  for (const e of byTs) {
    const workflowRunId = e.workflowId;
    const key = groupKey(workflowRunId, e.runId);
    let g = groupMap.get(key);
    if (!g) {
      g = {
        workflowRunId,
        runId: e.runId,
        firstTs: e.ts,
        lastTs: e.ts,
        roles: new Set<string>(),
        steps: [],
      };
      groupMap.set(key, g);
      groupOrder.push(key);
    }

    if (e.type === "token") {
      const piece = String(e.payload.token ?? "");
      const lastStep = g.steps[g.steps.length - 1];
      if (lastStep?.label === `${e.role} 流式输出（已合并）`) {
        lastStep.detail += piece;
        lastStep.ts = e.ts;
        g.lastTs = e.ts;
      } else {
        pushStep(g, {
          ts: e.ts,
          label: `${e.role} 流式输出（已合并）`,
          detail: piece,
        });
      }
      continue;
    }

    let label = `${e.role} ${e.type}`;
    if (e.type === "tool_call_start") {
      label = `${e.role} 调用工具 ${String(e.payload.targetName ?? e.payload.toolName ?? "")}`;
    }
    if (e.type === "tool_call_end") {
      label = `${e.role} 工具结束 ${String(e.payload.status ?? "")}`;
    }
    if (e.type === "observe") label = `${e.role} observe #${e.stepIndex}`;
    if (e.type === "step_persisted") label = `${e.role} step_persisted #${e.stepIndex}`;
    if (e.type === "final") label = `${e.role} 完成`;
    if (e.type === "error") label = `${e.role} 失败: ${String(e.payload.error ?? "unknown")}`;

    let detail: string;
    try {
      detail = JSON.stringify(e.payload, null, 2);
    } catch {
      detail = String(e.payload);
    }
    pushStep(g, { ts: e.ts, label, detail });
  }

  return groupOrder.map((key) => {
    const g = groupMap.get(key)!;
    const roles = [...g.roles];
    return {
      workflowRunId: g.workflowRunId,
      runId: g.runId,
      at: g.lastTs,
      firstTs: g.firstTs,
      roleSummary: roles.length ? roles.join(" · ") : "—",
      steps: g.steps,
    };
  });
}
