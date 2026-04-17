import { z } from "zod";
import type { A2AMessageType, AgentRole } from "./entities";

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
  params: z.record(z.unknown()),
  deadline: z.string().optional(),
  assignedRole: z.custom<AgentRole>(),
});

export type TaskAssignPayload = z.infer<typeof TaskAssignPayloadSchema>;

export const TaskResultPayloadSchema = z.object({
  taskId: z.string(),
  success: z.boolean(),
  result: z.unknown().nullable(),
  errorMessage: z.string().nullable().optional(),
  durationMs: z.number().int().min(0),
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
