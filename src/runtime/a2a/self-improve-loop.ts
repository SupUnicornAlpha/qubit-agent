/**
 * A2A self-improve / reflection loop 入口（P2-A Batch 4）。
 *
 * 给后续 Agent 自我迭代 / 离线反思 / prompt 自调优留一个标准入口。
 *
 * 与 Batch 3 (autonomous-trigger) 的区别：
 *   - autonomous-trigger：**外部事件**（市场/风控/新闻）→ A2A 总线
 *   - self-improve-loop：**Agent 自我反思**（一次 workflow 结束 / 一段
 *     交易窗口结束）→ A2A 总线，让 Agent 自己回看产出、更新长期记忆 /
 *     prompt / 策略参数
 *
 * 设计取舍（同 Batch 3）：
 *   - 只交付接口 + zod schema + 测试基线，不主动改 LLM prompt /
 *     longterm store；让消费端（memory-consolidation / orchestrator 自身
 *     的 reflection skill）自己决定怎么落地。
 *   - 实现复用 triggerAutonomousA2A，避免重复造路由分支。
 *
 * 触发时机示例：
 *   1) onWorkflowTerminal(completed) 后 → memory-consolidation 做完规则式
 *      提炼，再 enqueue 一个 reflection 让 LLM 做"为什么这次成功 / 失败"的
 *      自由叙述（写入 longterm memory）。
 *   2) 一天交易结束后 → 调用 requestPortfolioReflection 让 trader_agent 总结
 *      P/L 分布 + 偏差，输出更新建议。
 *   3) 因子库或策略库被自动 retrain 时 → reflect 上次 retrain 的 OOS 表现。
 */

import { z } from "zod";
import type { AgentRole } from "../../types/entities";
import {
  triggerAutonomousA2A,
  type AutonomousTriggerResult,
} from "./autonomous-trigger";

/**
 * 反思 scope。决定 LLM 看哪些 agent_step / outcome：
 *   - workflow_completed：一次完整 workflow 跑完的事后反思（默认）
 *   - workflow_failed：失败 workflow 的 root cause / lesson learned
 *   - daily_summary：跨多个 workflow 的日总结
 *   - factor_retrain：因子库自动 retrain 后的反思
 *   - strategy_drift：策略 OOS 表现偏离训练集时的反思
 */
export const ReflectionScopeSchema = z.enum([
  "workflow_completed",
  "workflow_failed",
  "daily_summary",
  "factor_retrain",
  "strategy_drift",
]);
export type ReflectionScope = z.infer<typeof ReflectionScopeSchema>;

export const ReflectionRequestSchema = z.object({
  scope: ReflectionScopeSchema,
  /** 反思源（哪个 workflow / 哪段时间窗 / 哪个 retrain run） */
  subjectId: z.string().min(1),
  /** 反思源的 human label，写入 reflection prompt */
  subjectLabel: z.string().optional(),
  /** 由谁反思；默认 orchestrator（它会 fan-out 给具体的 agent） */
  targetRole: z.custom<AgentRole>().optional(),
  /**
   * 是否 attach 到原 workflow：
   *   - true：附在 subjectId（前提 subjectId 是 workflowRunId）上，复用 timeline；
   *   - false（默认）：新建 a2a workflow，让反思任务独立审计 / 失败也不污染原流程。
   */
  attachToSubject: z.boolean().default(false),
  /** 反思任务附带的 metadata，会透传给 LLM */
  context: z.record(z.unknown()).default({}),
  /** 反思的"急迫度"。daily_summary 用 info；strategy_drift 用 warn；critical 留给越限 */
  severity: z.enum(["info", "warn", "error", "critical"]).default("info"),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
});
export type ReflectionRequest = z.infer<typeof ReflectionRequestSchema>;

/**
 * 让 Agent 进入"反思"模式。
 *
 * 行为：构造一条 reflection_request 的 autonomous trigger，并通过 Batch 3
 * 入口走 A2A 总线（schema + governance 校验沿用）。
 *
 * 返回：autonomous trigger 的 dispatch 结果，调用方可以拿 workflowRunId
 * 去轮询 /analyst/job/:id 或 /workflows/:id/timeline 看反思过程。
 */
export async function requestReflection(
  raw: ReflectionRequest,
): Promise<AutonomousTriggerResult> {
  const input = ReflectionRequestSchema.parse(raw);

  const message =
    input.subjectLabel != null
      ? `Reflection (${input.scope}) on "${input.subjectLabel}"`
      : `Reflection (${input.scope}) on subject=${input.subjectId}`;

  const workflowRunId =
    input.attachToSubject && input.scope.startsWith("workflow_")
      ? input.subjectId
      : undefined;

  return triggerAutonomousA2A({
    kind: "reflection_request",
    source: `self-improve:${input.scope}`,
    payload: {
      scope: input.scope,
      subjectId: input.subjectId,
      ...(input.subjectLabel ? { subjectLabel: input.subjectLabel } : {}),
      ...input.context,
    },
    ...(input.targetRole ? { targetRole: input.targetRole } : {}),
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    severity: input.severity,
    message,
  });
}
