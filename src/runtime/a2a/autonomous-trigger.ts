/**
 * A2A 自主 trigger 入口（P2-A Batch 3）。
 *
 * 目的：为后续 Agent 自主交易 / 自我迭代留一个干净的事件入口。外部事件源
 *   - 市场行情告警（kline 突破 / 波动率突刺）
 *   - 风控阈值越界
 *   - 模型 / 因子热更新
 *   - 策略信号 fire
 *   - Agent 自我反思请求
 * 都可以通过此入口"一行调用"派发到 A2A 总线，由 orchestrator 或指定 role
 * 自主处理。**不挂 cron、不挂 HTTP，纯事件驱动**。
 *
 * 与 scheduler.ts 的区别：
 *   - scheduler：cron 周期 + trigger gate（仅作为定时器的"准入条件"）
 *   - 本模块：事件 push，无周期，是 cron 的对立面
 *
 * Batch 3 主体是定义并落实接口；现阶段未接到具体事件源（后续 Batch 4 接
 * reflection / 真正 market data 流），但 router schema 校验 (Batch 1) +
 * a2a resume 路径自洽 (Batch 2) 已经让"一旦事件来了就立刻可用"成立。
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { a2aRouter } from "../../messaging/a2a";
import type { AgentRole } from "../../types/entities";
import { dispatchTaskToRole } from "../agent-pool";
import { createAndDispatchWorkflow } from "../workflow/workflow-service";

/** 触发种类。新增需同步 README 与 orchestrator prompt 里的 schema 约定。 */
export const AutonomousTriggerKindSchema = z.enum([
  "market_alert",
  "news_event",
  "risk_breach",
  "model_update",
  "strategy_signal",
  "reflection_request",
  "custom",
]);
export type AutonomousTriggerKind = z.infer<typeof AutonomousTriggerKindSchema>;

export const AutonomousTriggerSeveritySchema = z.enum([
  "info",
  "warn",
  "error",
  "critical",
]);
export type AutonomousTriggerSeverity = z.infer<
  typeof AutonomousTriggerSeveritySchema
>;

export const AutonomousTriggerInputSchema = z.object({
  /** 事件种类，决定 orchestrator/handler 的语义 */
  kind: AutonomousTriggerKindSchema,
  /** 触发源标识，例如 "market_data_v2", "risk_engine"，仅用于审计 / 日志 */
  source: z.string().min(1),
  /** 业务 payload，透传给目标 role；schema 由消费端自行定义 */
  payload: z.record(z.unknown()).default({}),
  /** 可选目标 role；不指定就 ALERT 给 orchestrator 让其自己分配 */
  targetRole: z.custom<AgentRole>().optional(),
  /** 可选 attach 到已有 workflow；不给则新建 a2a workflow */
  workflowRunId: z.string().optional(),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  /** 影响 A2A 消息 priority（critical=95, error=80, warn=65, info=50） */
  severity: AutonomousTriggerSeveritySchema.default("info"),
  /** 人类可读消息；orchestrator 决策时会用到 */
  message: z.string().optional(),
});
export type AutonomousTriggerInput = z.infer<typeof AutonomousTriggerInputSchema>;

export type AutonomousTriggerDispatch =
  | "alert_only"
  | "task_assigned"
  | "workflow_created";

export interface AutonomousTriggerResult {
  triggerId: string;
  workflowRunId: string;
  /** 由 dispatcher 返回；alert_only 时无 runId */
  runId?: string;
  dispatched: AutonomousTriggerDispatch;
}

function severityToPriority(severity: AutonomousTriggerSeverity): number {
  switch (severity) {
    case "critical":
      return 95;
    case "error":
      return 80;
    case "warn":
      return 65;
    default:
      return 50;
  }
}

/**
 * 自主触发主入口。三条分支：
 *   1. workflowRunId + targetRole 都给 → 直接派 TASK_ASSIGN（最高效）
 *   2. workflowRunId 给但没 targetRole → 发 ALERT 给 orchestrator
 *   3. 都没给 → 新建一个 executionPath=a2a 的 workflow 并派 TASK_ASSIGN 给 orchestrator
 *
 * 注意：所有分支最终都落到 a2aRouter / dispatchTaskToRole，享受 Batch 1
 * envelope+payload schema 校验保护；payload 形状异常 strict 模式会直接 throw。
 */
export async function triggerAutonomousA2A(
  raw: AutonomousTriggerInput,
): Promise<AutonomousTriggerResult> {
  const input = AutonomousTriggerInputSchema.parse(raw);
  const triggerId = randomUUID();

  /** Branch 1：附到现有 workflow + targetRole */
  if (input.workflowRunId && input.targetRole) {
    const dispatch = await dispatchTaskToRole({
      workflowId: input.workflowRunId,
      role: input.targetRole,
      payload: {
        taskId: randomUUID(),
        taskType: `autonomous_${input.kind}`,
        assignedRole: input.targetRole,
        params: {
          triggerId,
          source: input.source,
          kind: input.kind,
          severity: input.severity,
          ...(input.message ? { message: input.message } : {}),
          ...input.payload,
        },
      },
    });
    return {
      triggerId,
      workflowRunId: input.workflowRunId,
      runId: dispatch.runId,
      dispatched: "task_assigned",
    };
  }

  /** Branch 2：附到现有 workflow，无 targetRole → ALERT 给 orchestrator */
  if (input.workflowRunId) {
    await a2aRouter.send({
      workflowId: input.workflowRunId,
      traceId: triggerId,
      senderAgent: input.source,
      receiverAgent: "orchestrator",
      messageType: "ALERT",
      payload: {
        alertType: input.kind,
        severity: input.severity,
        message: input.message ?? `Autonomous trigger from ${input.source}`,
        metadata: { triggerId, ...input.payload },
      },
      priority: severityToPriority(input.severity),
    });
    return {
      triggerId,
      workflowRunId: input.workflowRunId,
      dispatched: "alert_only",
    };
  }

  /** Branch 3：新建 a2a workflow + 派 TASK_ASSIGN 给 orchestrator */
  const created = await createAndDispatchWorkflow({
    projectId: input.projectId ?? "default",
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    source: "api",
    goal: input.message ?? `Autonomous A2A trigger: ${input.kind} from ${input.source}`,
    mode: "research",
    taskType: `autonomous_${input.kind}`,
    params: {
      triggerId,
      source: input.source,
      kind: input.kind,
      severity: input.severity,
      ...input.payload,
    },
    executionPath: "a2a",
  });

  return {
    triggerId,
    workflowRunId: created.data.id,
    ...(created.runId ? { runId: created.runId } : {}),
    dispatched: "workflow_created",
  };
}
