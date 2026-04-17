import { z } from "zod";
import type { ConnectorTargetKind } from "./entities";

// ─── ACP Request ─────────────────────────────────────────────────────────────

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10).default(3),
  backoffMs: z.number().int().min(0).default(500),
  backoffMultiplier: z.number().min(1).default(2),
});

export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const AcpRequestSchema = z.object({
  traceId: z.string(),
  sessionId: z.string(),
  workflowId: z.string(),
  senderAgent: z.string(),
  targetKind: z.enum(["skill", "mcp", "tool", "connector"] as const satisfies readonly ConnectorTargetKind[]),
  targetName: z.string(),
  intent: z.string(),
  inputSchemaVersion: z.string().default("1.0"),
  payload: z.unknown(),
  timeoutMs: z.number().int().min(0).default(30_000),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).default("low"),
  priority: z.number().int().min(0).max(100).default(50),
  retryPolicy: RetryPolicySchema.optional(),
  idempotencyKey: z.string().optional(),
});

export type AcpRequest = z.infer<typeof AcpRequestSchema>;

// ─── ACP Response ─────────────────────────────────────────────────────────────

export const AcpResponseSchema = z.object({
  traceId: z.string(),
  status: z.enum(["success", "error", "timeout", "blocked"]),
  errorCode: z.string().nullable().default(null),
  latencyMs: z.number().int().min(0),
  outputSchemaVersion: z.string().default("1.0"),
  result: z.unknown().nullable(),
});

export type AcpResponse = z.infer<typeof AcpResponseSchema>;

// ─── ACP Standard Error Codes ────────────────────────────────────────────────

export const ACP_ERROR_CODES = {
  AUTH_FAILED: "ACP_AUTH_FAILED",
  RATE_LIMITED: "ACP_RATE_LIMITED",
  TIMEOUT: "ACP_TIMEOUT",
  INVALID_PAYLOAD: "ACP_INVALID_PAYLOAD",
  CONNECTOR_ERROR: "ACP_CONNECTOR_ERROR",
  RISK_BLOCKED: "ACP_RISK_BLOCKED",
  NOT_FOUND: "ACP_NOT_FOUND",
  CIRCUIT_OPEN: "ACP_CIRCUIT_OPEN",
  VERSION_MISMATCH: "ACP_VERSION_MISMATCH",
} as const;

export type AcpErrorCode = (typeof ACP_ERROR_CODES)[keyof typeof ACP_ERROR_CODES];

// ─── ACP Call Context (runtime, not persisted) ──────────────────────────────

export interface AcpCallContext {
  request: AcpRequest;
  startedAt: number;
  attemptCount: number;
}
