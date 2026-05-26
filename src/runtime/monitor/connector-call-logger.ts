/**
 * 监控 V2 P2 — Connector 调用日志写入器。
 *
 * 设计目标（详见 docs/MONITORING_V2_DESIGN.md §4.1.5 / 摸排报告 P2-1）：
 *   - 每次 connector 调用（broker / market / news 等）写一行 `connector_call_log`
 *   - 通过 ACP 入口统一打点，不要求 connector 自己改代码（HOC 风格）
 *   - 失败 try/catch + console.warn；监控写库失败不阻塞业务
 *   - secret-strip：请求/响应 payload 跑 redactPayload，并限制总长度
 *
 * 用法（在 src/messaging/acp.ts AcpCaller.call 完成后调用）：
 *   await writeConnectorCallLog({
 *     traceId, workflowRunId, connectorName,
 *     operation: "execute",
 *     request, response, latencyMs, status,
 *   });
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../../db/sqlite/client";
import { connectorCallLog } from "../../db/sqlite/schema";
import { redactPayload } from "../../util/redact-secrets";

export type ConnectorCallStatus = "success" | "error" | "timeout";
export type ConnectorOperation = "init" | "healthcheck" | "execute" | "shutdown";

export type ConnectorCallLogInput = {
  traceId: string;
  workflowRunId: string | null;
  connectorName: string;
  /** 持久化 connector_instance 行 id；通常 null（市场 / 新闻类无 instance） */
  connectorInstanceId?: string | null;
  /** ACP call 行 id；可选 */
  acpCallId?: string | null;
  operation: ConnectorOperation;
  request: unknown;
  response?: unknown;
  latencyMs: number;
  status: ConnectorCallStatus;
  errorMessage?: string;
};

/** 错误消息截断长度 — 与 llm_call_log 保持一致 */
const ERR_MSG_MAX = 500;
/** payload JSON 序列化字节上限 — 与 redact-secrets 默认值一致 */
const PAYLOAD_MAX_BYTES = 8192;

export async function writeConnectorCallLog(input: ConnectorCallLogInput): Promise<void> {
  try {
    const db = await getDb();
    /**
     * 这里同时跑 redact + 截断：
     *   - request 可能含 broker 账号 / API key
     *   - response 可能含敏感 token / cookie
     * 跑过 redactPayload 之后再 JSON.stringify，最长 8KB。
     */
    const safeRequest = redactPayload(input.request, { maxBytes: PAYLOAD_MAX_BYTES });
    const safeResponse =
      input.response !== undefined
        ? redactPayload(input.response, { maxBytes: PAYLOAD_MAX_BYTES })
        : null;

    await db.insert(connectorCallLog).values({
      id: randomUUID(),
      connectorInstanceId: input.connectorInstanceId ?? null,
      connectorName: input.connectorName,
      workflowRunId: input.workflowRunId,
      acpCallId: input.acpCallId ?? null,
      traceId: input.traceId,
      operation: input.operation,
      requestJson: ensureJsonValue(safeRequest),
      responseJson: safeResponse === null ? null : ensureJsonValue(safeResponse),
      latencyMs: Math.max(0, Math.round(input.latencyMs)),
      status: input.status,
      errorMessage: input.errorMessage ? input.errorMessage.slice(0, ERR_MSG_MAX) : null,
    });
  } catch (err) {
    /** 监控失败绝不抛 — 业务路径必须能继续 */
    console.warn(
      `[connectorCallLog] insert failed (connector=${input.connectorName} op=${input.operation}): ${(err as Error).message}`
    );
  }
}

/**
 * `redactPayload` 在超长时返回字符串（含 …[truncated …]）；
 * drizzle JSON 列要求可序列化对象 / 数组。为兼容两种情况，包一层。
 */
function ensureJsonValue(v: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(v)) return v;
  if (v && typeof v === "object") return v as Record<string, unknown>;
  // 字符串 / 数字 / boolean / null：包成 { value } 才能写 JSON 列
  return { value: v as string | number | boolean | null };
}
