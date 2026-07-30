import { z } from "zod";
import type { A2AMessageType, AgentRole } from "./entities";

/**
 * Internal transport stays local, but task semantics deliberately mirror the
 * A2A protocol: a task is the durable unit of delegated work and messages are
 * merely delivery events around that task.
 */
export const A2ATaskStateSchema = z.enum([
  "submitted",
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);
export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

export const A2ATaskTerminalStates = new Set<A2ATaskState>([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);

export function isA2ATaskTerminal(state: A2ATaskState): boolean {
  return A2ATaskTerminalStates.has(state);
}

export const A2ATaskEventTypeSchema = z.enum([
  "submitted",
  "working",
  "progress",
  "artifact",
  "input_required",
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);
export type A2ATaskEventType = z.infer<typeof A2ATaskEventTypeSchema>;

// ─── A2A Message Schema ───────────────────────────────────────────────────────

export const A2AMessageSchema = z.object({
  messageId: z.string(),
  workflowId: z.string(),
  traceId: z.string(),
  senderAgent: z.string(),
  receiverAgent: z.string(),
  messageType: z.enum([
    "TASK_ASSIGN",
    "TASK_RESULT",
    "TASK_PROGRESS",
    "RISK_BLOCK",
    "ORDER_INTENT",
    "MODEL_UPDATE",
    "MEMORY_WRITE",
    "ALERT",
  ] as const satisfies readonly A2AMessageType[]),
  payload: z.unknown(),
  priority: z.number().int().min(0).max(100).default(50),
  createdAt: z.string(),
});

export type A2AMessageEnvelope = z.infer<typeof A2AMessageSchema>;

// ─── Payload Shapes per Message Type ─────────────────────────────────────────

export const TaskAssignPayloadSchema = z.object({
  taskId: z.string(),
  taskType: z.string(),
  /** V2 first-class goal; legacy callers may still put it in params.goal. */
  goal: z.string().min(1).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).optional(),
  acceptance: z
    .object({
      requiredEvidence: z.enum(["market_data", "news", "analysis", "none"]).optional(),
      maxToolCalls: z.number().int().positive().optional(),
    })
    .optional(),
  params: z.record(z.unknown()),
  deadline: z.string().optional(),
  assignedRole: z.custom<AgentRole>(),
  /**
   * 调度器预先分配的执行流 ID。调用方会立即用它订阅逐 token SSE，worker 必须沿用，
   * 不能在真正执行时再生成另一个 ID。
   */
  executionRunId: z.string().min(1).optional(),
});

export type TaskAssignPayload = z.infer<typeof TaskAssignPayloadSchema>;

/**
 * Specialist → parent lease heartbeat / phase signal.
 * Does not settle gather; only renews the communication lease.
 */
export const TaskProgressPayloadSchema = z.object({
  taskId: z.string().min(1),
  phase: z.enum(["start", "reason", "act", "observe", "heartbeat", "other"]),
  iteration: z.number().int().min(0).optional(),
  role: z.custom<AgentRole>().optional(),
  detail: z.string().max(500).optional(),
  ts: z.string().optional(),
});

export type TaskProgressPayload = z.infer<typeof TaskProgressPayloadSchema>;

export const TaskResultStatusSchema = z.enum([
  "completed",
  "failed",
  "timeout",
  "awaiting_approval",
  "cancelled",
]);

export type TaskResultStatus = z.infer<typeof TaskResultStatusSchema>;

export function isA2ATaskContractV2Enabled(): boolean {
  return process.env.A2A_TASK_CONTRACT_V2 !== "0";
}

/**
 * V2 fields are optional only so persisted V1 messages remain readable. Any
 * payload that opts into V2 status must obey the terminal/error contract.
 */
export const TaskResultPayloadSchema = z
  .object({
    taskId: z.string(),
    success: z.boolean(),
    status: TaskResultStatusSchema.optional(),
    result: z.unknown().nullable(),
    errorCode: z.string().min(1).nullable().optional(),
    errorMessage: z.string().min(1).nullable().optional(),
    evidence: z
      .object({
        kind: z.string().min(1),
        verified: z.boolean(),
        detail: z.record(z.unknown()).optional(),
      })
      .optional(),
    summary: z.string().min(1).optional(),
    durationMs: z.number().int().min(0),
  })
  .superRefine((value, ctx) => {
    if (!isA2ATaskContractV2Enabled() || !value.status) return; // V1 compatibility / rollback.
    if (value.status === "completed" && !value.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "completed TASK_RESULT must succeed" });
    }
    if (value.status !== "completed" && value.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "non-completed TASK_RESULT cannot succeed",
      });
    }
    if (value.status !== "completed" && (!value.errorCode || !value.errorMessage)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed TASK_RESULT requires errorCode and errorMessage",
      });
    }
  });

export type TaskResultPayload = z.infer<typeof TaskResultPayloadSchema>;

export const RiskBlockPayloadSchema = z.object({
  orderIntentId: z.string(),
  riskRuleId: z.string(),
  reason: z.string(),
  severity: z.enum(["block", "warn", "info"]),
  signature: z.string(),
});

export type RiskBlockPayload = z.infer<typeof RiskBlockPayloadSchema>;

export const OrderIntentPayloadSchema = z.object({
  orderIntentId: z.string(),
  instrumentId: z.string(),
  side: z.enum(["buy", "sell"]),
  qty: z.number(),
  orderType: z.enum(["market", "limit", "stop", "stop_limit"]),
  price: z.number().nullable().optional(),
  timeInForce: z.enum(["day", "gtc", "ioc", "fok"]),
  riskSignature: z.string().optional(),
});

export type OrderIntentPayload = z.infer<typeof OrderIntentPayloadSchema>;

export const MemoryWritePayloadSchema = z.object({
  layer: z.enum(["session", "midterm", "longterm"]),
  memoryType: z.string(),
  content: z.unknown(),
  asofTime: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export type MemoryWritePayload = z.infer<typeof MemoryWritePayloadSchema>;

export const AlertPayloadSchema = z.object({
  alertType: z.string(),
  severity: z.enum(["info", "warn", "error", "critical"]),
  message: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export type AlertPayload = z.infer<typeof AlertPayloadSchema>;

// ─── A2A Governance Rules (documented constraints) ───────────────────────────

/**
 * Governance rules enforced by the A2A router:
 * 1. Only one primary decision-maker per workflow_id (default: Orchestrator).
 * 2. Risk Agent holds veto power over ORDER_INTENT messages.
 * 3. Execution Agent only consumes risk-signed order intents.
 */
export const A2A_GOVERNANCE = {
  PRIMARY_DECISION_MAKER_ROLE: "orchestrator" as AgentRole,
  VETO_AGENT_ROLE: "risk" as AgentRole,
  VETO_MESSAGE_TYPE: "ORDER_INTENT" as A2AMessageType,
  EXECUTION_REQUIRES_RISK_SIGNATURE: true,
} as const;
