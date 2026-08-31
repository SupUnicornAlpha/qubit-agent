import type { AgentControlMode } from "../types/loop";

/**
 * Harness 控制面工具不属于业务工具权限面。
 *
 * 它们只能修改当前 workflow 自身的运行态，不访问行情、不派单、不写外部系统；
 * 因而不能依赖可能滞后的业务 sandbox allow-list，否则会出现“prompt 要求调用，
 * sandbox 又拒绝”的自相矛盾。
 */
export const AGENT_CONTROL_PLANE_TOOLS = ["update_plan"] as const;
const AGENT_CONTROL_PLANE_TOOL_SET = new Set<string>(AGENT_CONTROL_PLANE_TOOLS);

export function isAgentControlPlaneTool(toolName: string): boolean {
  return AGENT_CONTROL_PLANE_TOOL_SET.has(toolName);
}

export type AgentPlanStepStatus = "pending" | "in_progress" | "done" | "skipped";

export type ResearchPhase = "scope" | "plan" | "evidence" | "analysis" | "validation" | "delivery";
export type ResearchPhaseStatus = "pending" | "active" | "completed" | "revisited" | "blocked";

export interface ResearchPhaseState {
  phase: ResearchPhase;
  status: ResearchPhaseStatus;
  note?: string;
}

export interface AgentPlanStepSnapshot {
  id: string;
  title: string;
  status: AgentPlanStepStatus;
  note?: string;
  researchPhase?: ResearchPhase;
}

export interface AgentPlanSnapshot {
  mode?: AgentControlMode;
  researchPhase?: ResearchPhase;
  researchPhases?: ResearchPhaseState[];
  goal?: {
    text?: string;
    status?: "planning" | "executing" | "paused" | "completed" | "blocked" | "cleared";
    completedSteps?: number;
    totalSteps?: number;
    successCriteria?: string[];
    constraints?: string[];
    verification?: {
      evidenceCount?: number;
      summary?: string;
      verifiedAt?: string;
    };
    blocker?: string;
  };
  steps: AgentPlanStepSnapshot[];
  updatedAt?: string;
}

const PLAN_STATUSES = new Set<AgentPlanStepStatus>(["pending", "in_progress", "done", "skipped"]);
const RESEARCH_PHASES = new Set<ResearchPhase>([
  "scope",
  "plan",
  "evidence",
  "analysis",
  "validation",
  "delivery",
]);
const RESEARCH_PHASE_STATUSES = new Set<ResearchPhaseStatus>([
  "pending",
  "active",
  "completed",
  "revisited",
  "blocked",
]);

export function parseResearchPhase(raw: unknown): ResearchPhase | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase() as ResearchPhase;
  return RESEARCH_PHASES.has(value) ? value : undefined;
}

export function parseResearchPhaseStatus(raw: unknown): ResearchPhaseStatus | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value === "queued") return "pending";
  if (value === "running" || value === "in_progress" || value === "in-progress") return "active";
  if (value === "done" || value === "complete") return "completed";
  if (value === "revisit") return "revisited";
  return RESEARCH_PHASE_STATUSES.has(value as ResearchPhaseStatus)
    ? (value as ResearchPhaseStatus)
    : undefined;
}

export function parseAgentPlanSnapshot(raw: unknown): AgentPlanSnapshot | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.steps)) return null;
  const steps = record.steps.flatMap((item, index): AgentPlanStepSnapshot[] => {
    if (!item || typeof item !== "object") return [];
    const step = item as Record<string, unknown>;
    const title = String(step.title ?? step.text ?? "").trim();
    if (!title) return [];
    const rawStatus = String(step.status ?? "pending") as AgentPlanStepStatus;
    const status = PLAN_STATUSES.has(rawStatus) ? rawStatus : "pending";
    const note = step.note == null ? "" : String(step.note).trim();
    const researchPhase = parseResearchPhase(step.researchPhase ?? step.research_phase);
    return [
      {
        id: String(step.id ?? `s${index + 1}`).slice(0, 40),
        title: title.slice(0, 200),
        status,
        ...(note ? { note: note.slice(0, 300) } : {}),
        ...(researchPhase ? { researchPhase } : {}),
      },
    ];
  });
  const mode =
    record.mode === "agent" ||
    record.mode === "plan" ||
    record.mode === "goal" ||
    record.mode === "ask" ||
    record.mode === "diagnose"
      ? record.mode
      : undefined;
  const researchPhase = parseResearchPhase(record.researchPhase ?? record.research_phase);
  const researchPhases = Array.isArray(record.researchPhases ?? record.research_phases)
    ? (record.researchPhases ?? record.research_phases)
        .flatMap((item): ResearchPhaseState[] => {
          if (!item || typeof item !== "object") return [];
          const phaseRecord = item as Record<string, unknown>;
          const phase = parseResearchPhase(
            phaseRecord.phase ?? phaseRecord.researchPhase ?? phaseRecord.research_phase
          );
          const status = parseResearchPhaseStatus(phaseRecord.status);
          if (!phase || !status) return [];
          return [
            {
              phase,
              status,
              ...(typeof phaseRecord.note === "string" && phaseRecord.note.trim()
                ? { note: phaseRecord.note.trim().slice(0, 300) }
                : {}),
            },
          ];
        })
        .filter(
          (state, index, states) =>
            states.findIndex((candidate) => candidate.phase === state.phase) === index
        )
        .slice(0, 6)
    : [];
  const goalRecord =
    record.goal && typeof record.goal === "object"
      ? (record.goal as Record<string, unknown>)
      : null;
  const goalStatus =
    goalRecord?.status === "planning" ||
    goalRecord?.status === "executing" ||
    goalRecord?.status === "paused" ||
    goalRecord?.status === "completed" ||
    goalRecord?.status === "blocked" ||
    goalRecord?.status === "cleared"
      ? goalRecord.status
      : undefined;
  const completedSteps =
    typeof goalRecord?.completedSteps === "number"
      ? goalRecord.completedSteps
      : typeof goalRecord?.completed_steps === "number"
        ? goalRecord.completed_steps
        : undefined;
  const totalSteps =
    typeof goalRecord?.totalSteps === "number"
      ? goalRecord.totalSteps
      : typeof goalRecord?.total_steps === "number"
        ? goalRecord.total_steps
        : undefined;
  const successCriteriaRaw = Array.isArray(goalRecord?.successCriteria)
    ? goalRecord.successCriteria
    : Array.isArray(goalRecord?.success_criteria)
      ? goalRecord.success_criteria
      : null;
  const constraintsRaw = Array.isArray(goalRecord?.constraints) ? goalRecord.constraints : null;
  const updatedAt =
    typeof record.updatedAt === "string"
      ? record.updatedAt
      : typeof record.updated_at === "string"
        ? record.updated_at
        : undefined;
  return {
    steps,
    ...(mode ? { mode } : {}),
    ...(researchPhase ? { researchPhase } : {}),
    ...(researchPhases.length > 0 ? { researchPhases } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(goalRecord
      ? {
          goal: {
            ...(typeof goalRecord.text === "string" ? { text: goalRecord.text } : {}),
            ...(goalStatus ? { status: goalStatus } : {}),
            ...(typeof completedSteps === "number" ? { completedSteps } : {}),
            ...(typeof totalSteps === "number" ? { totalSteps } : {}),
            ...(successCriteriaRaw
              ? {
                  successCriteria: successCriteriaRaw
                    .filter((item): item is string => typeof item === "string")
                    .map((item) => item.trim().slice(0, 300))
                    .filter(Boolean)
                    .slice(0, 10),
                }
              : {}),
            ...(constraintsRaw
              ? {
                  constraints: constraintsRaw
                    .filter((item): item is string => typeof item === "string")
                    .map((item) => item.trim().slice(0, 300))
                    .filter(Boolean)
                    .slice(0, 10),
                }
              : {}),
            ...(goalRecord.verification && typeof goalRecord.verification === "object"
              ? {
                  verification: {
                    ...(typeof (goalRecord.verification as Record<string, unknown>)
                      .evidenceCount === "number"
                      ? {
                          evidenceCount: (goalRecord.verification as Record<string, number>)
                            .evidenceCount,
                        }
                      : {}),
                    ...(typeof (goalRecord.verification as Record<string, unknown>).summary ===
                    "string"
                      ? {
                          summary: String(
                            (goalRecord.verification as Record<string, unknown>).summary
                          ).slice(0, 1000),
                        }
                      : {}),
                    ...(typeof (goalRecord.verification as Record<string, unknown>).verifiedAt ===
                    "string"
                      ? {
                          verifiedAt: String(
                            (goalRecord.verification as Record<string, unknown>).verifiedAt
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
            ...(typeof goalRecord.blocker === "string"
              ? { blocker: goalRecord.blocker.slice(0, 1000) }
              : {}),
          },
        }
      : {}),
  };
}

/** Ask 模式只读控制面（对齐 Core InteractionMode::Ask）。 */
const ASK_MODE_TOOLS = new Set([
  "update_plan",
  "workspace.read",
  "workspace.list",
  "session.diagnose",
]);

/**
 * Plan / Ask 是运行时能力边界，不依赖模型自觉。
 * - plan：仅 update_plan
 * - ask：只读控制面工具
 * - agent / goal / diagnose：全工具面（再由 sandbox / policy 收窄）
 */
export function isToolAllowedInAgentControlMode(mode: AgentControlMode, toolName: string): boolean {
  if (mode === "plan") return toolName === "update_plan";
  if (mode === "ask") return ASK_MODE_TOOLS.has(toolName);
  return true;
}

export function assessGoalPlanCompletion(rawPlan: unknown): {
  ok: boolean;
  code:
    | "complete"
    | "missing_plan"
    | "unfinished_steps"
    | "invalid_progress"
    | "paused"
    | "blocked"
    | "cleared"
    | "no_completed_work"
    | "undocumented_skip";
  message: string;
  pendingStepIds: string[];
} {
  const plan = parseAgentPlanSnapshot(rawPlan);
  if (!plan || plan.steps.length === 0) {
    return {
      ok: false,
      code: "missing_plan",
      message: "Goal 模式必须先用 update_plan 建立可追踪计划，再执行并验证目标。",
      pendingStepIds: [],
    };
  }
  if (plan.goal?.status === "paused") {
    return {
      ok: false,
      code: "paused",
      message: "Goal 已暂停；恢复后才能继续执行或完成。",
      pendingStepIds: plan.steps
        .filter((step) => step.status === "pending" || step.status === "in_progress")
        .map((step) => step.id),
    };
  }
  if (plan.goal?.status === "blocked") {
    return {
      ok: false,
      code: "blocked",
      message: plan.goal.blocker
        ? `Goal 当前受阻：${plan.goal.blocker}`
        : "Goal 当前受阻，不能标记为已完成。",
      pendingStepIds: [],
    };
  }
  if (plan.goal?.status === "cleared") {
    return {
      ok: false,
      code: "cleared",
      message: "Goal 已由用户清除。",
      pendingStepIds: [],
    };
  }
  const active = plan.steps.filter((step) => step.status === "in_progress");
  if (active.length > 1) {
    return {
      ok: false,
      code: "invalid_progress",
      message: "Goal 计划同一时刻只能有一个 in_progress 步骤。",
      pendingStepIds: active.map((step) => step.id),
    };
  }
  const pending = plan.steps.filter(
    (step) => step.status === "pending" || step.status === "in_progress"
  );
  if (pending.length > 0) {
    return {
      ok: false,
      code: "unfinished_steps",
      message: `Goal 模式还有 ${pending.length} 个未闭环步骤；请继续执行、验证，并更新计划状态。`,
      pendingStepIds: pending.map((step) => step.id),
    };
  }
  const undocumentedSkipped = plan.steps.filter(
    (step) => step.status === "skipped" && !step.note?.trim()
  );
  if (undocumentedSkipped.length > 0) {
    return {
      ok: false,
      code: "undocumented_skip",
      message: "被跳过的 Goal 步骤必须写明原因，才能判断是否满足完成条件。",
      pendingStepIds: undocumentedSkipped.map((step) => step.id),
    };
  }
  if (!plan.steps.some((step) => step.status === "done")) {
    return {
      ok: false,
      code: "no_completed_work",
      message: "Goal 没有任何已完成步骤；全部跳过不能视为目标完成。",
      pendingStepIds: [],
    };
  }
  return {
    ok: true,
    code: "complete",
    message: "Goal 计划已经闭环。",
    pendingStepIds: [],
  };
}

export function buildAgentControlModePrompt(
  mode: AgentControlMode,
  isOrchestrator: boolean
): string {
  if (!isOrchestrator) {
    if (mode === "plan") {
      return [
        "## 当前工作模式：Plan",
        "你只负责分析与提出计划，不得调用业务工具、派发任务、获取实时数据或写入外部状态。",
        "如收到执行型子任务，请返回建议步骤和依赖，不要声称已经执行。",
      ].join("\n");
    }
    if (mode === "ask") {
      return [
        "## 当前工作模式：Ask",
        "你只做问答与分析；不得派单、下单、写业务状态。",
        "仅可使用只读控制面工具（update_plan / workspace.read / workspace.list / session.diagnose）。",
      ].join("\n");
    }
    if (mode === "diagnose") {
      return [
        "## 当前工作模式：检查（Diagnose）",
        "聚焦根因与失败归因；优先复盘工具账本、错误码与数据缺口，再给可验证的修复建议。",
      ].join("\n");
    }
    return "";
  }
  if (mode === "plan") {
    return [
      "## 当前工作模式：Plan（硬约束）",
      "- 本轮只澄清目标、识别依赖/风险并形成可执行计划；不得实际查询行情、派发专家、运行回测或写入业务数据。",
      "- 必须调用一次 `update_plan`，写入 3-7 个可验证步骤；所有尚未执行的步骤保持 pending。",
      "- 建好计划后用 `tool=none` 返回：目标理解、关键假设、执行顺序、验收条件和阻塞项。",
      "- 你不能自行退出 Plan 模式。告知用户可点击计划卡片中的“按此计划执行”，或手动切换到 Goal/Agent 后再发送。",
      "- 不得使用“已查询、已验证、已完成”等措辞描述尚未执行的事情。",
    ].join("\n");
  }
  if (mode === "goal") {
    return [
      "## 当前工作模式：Goal（自主闭环）",
      "- 把用户消息当作需要持续推进到终态的目标，而不是只回答一次。",
      "- 目标文本本身就是完成条件；先提取预期结果、约束和可验证的完成标准，再规划执行。",
      "- 开始执行前必须调用 `update_plan` 建立 3-7 步计划；执行中保持恰好一个 in_progress，并及时更新 done/skipped。",
      "- 可按需要调用工具、切换数据源、派发既定团队之外的专家；失败时先恢复或降级，再决定是否带限制继续。",
      "- 只有计划中没有 pending/in_progress，且关键结论已有工具结果、产物或明确验证证据时，才可 `tool=none` 结束。",
      "- 无法完成的步骤必须标记 skipped 并写明原因；全部步骤都 skipped 时目标是 blocked，不是 completed。",
      "- 用户可以在运行中补充上下文或调整约束；采纳最新指令，但不得因此扩大权限、沙箱或审批边界。",
      "- 最终答复区分已完成、未完成、验证证据和后续动作，禁止把部分完成包装成全部成功。",
    ].join("\n");
  }
  if (mode === "ask") {
    return [
      "## 当前工作模式：Ask（只读问答）",
      "- 用已有上下文与只读工具回答问题；禁止派发专家、写推荐/下单/改策略或刷业务工具。",
      "- 允许工具：`update_plan`（可选）、`workspace.read`、`workspace.list`、`session.diagnose`。",
      "- 信息不足时明确列出缺口与下一步建议，而不是假装已取数。",
      "- 用户若要执行研究/交易，应提示切换到 Agent / Goal。",
    ].join("\n");
  }
  if (mode === "diagnose") {
    return [
      "## 当前工作模式：检查（Diagnose）",
      "- 目标是定位失败根因与可复现证据，而不是直接推进交易/选股交付。",
      "- 优先复盘工具失败、数据缺口、政策熔断、HITL 阻塞与会话账本；必要时可调用诊断与只读工具。",
      "- 输出：现象 → 证据 → 根因假设 → 已排除项 → 建议修复/重试步骤。",
      "- 不要把检查结论包装成已完成的业务交付。",
    ].join("\n");
  }
  return [
    "## 当前工作模式：Agent",
    "- 根据用户请求直接回答或按需使用工具；简单问题无需建计划。",
    "- 多步任务可用 `update_plan` 提升过程可见性，但不要为了形式扩大任务范围。",
    "- 默认遵守当前团队拓扑；缺少关键能力时明确说明，不擅自宣称已完成。",
  ].join("\n");
}
