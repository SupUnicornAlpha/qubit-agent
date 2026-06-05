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
  /**
   * 2026-06-05 修复（监控复盘 #3）：原 schema 只有 errorCode，导致 connector 抛出的
   * 真实 stderr / Error.message 在 MessagingClient 里被静默吞掉，LLM 只看到
   * 字符串 "ACP_CONNECTOR_ERROR" → 无法判断是参数错、auth 失败、还是 connector
   * 内部异常 → 进入"盲重试 / 切换其它工具"模式，最终 sample 6 次 version_strategy
   * 全部 fail 但 LLM 始终不知道哪个 param 是错的。
   *
   * 加 errorDetail 字段（可选）承载 lastError.message slice(0, 800)；act.ts 在拼
   * errorMessage 时优先用它，让 LLM 在下一轮能看到 "ACP_CONNECTOR_ERROR: factor
   * 4f...not found in this project" 之类有意义的提示，自修。
   */
  errorDetail: z.string().nullable().optional(),
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
