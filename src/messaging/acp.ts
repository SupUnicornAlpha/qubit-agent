import { randomUUID } from "node:crypto";
import type { AcpRequest, AcpResponse } from "../types/acp";
import { ACP_ERROR_CODES } from "../types/acp";

export interface AcpCallerOptions {
  defaultTimeoutMs?: number;
  auditEnabled?: boolean;
}

/**
 * ACP (Agent Communication Protocol) caller.
 *
 * Wraps all outbound capability calls (skills, tools, connectors) with:
 * - Timeout enforcement
 * - Retry with exponential backoff
 * - Latency measurement
 * - Error normalization
 * - Audit logging (stub, wired in V1 implementation)
 *
 * Schema 收敛 C5-2（2026-06）：原先这里支持注入 `onCallObserved` hook 把每次调用
 * 落入 `connector_call_log`。但表已删除（前端零消费方），hook + logger 整套机制
 * 同时移除。如需在 ACP 层重新埋点，可直接在 `call()` 末尾打 `tool_call_log`
 * （`toolKind='acp_connector'`），无需再走 hook 注入。
 */
export class AcpCaller {
  private options: Required<Pick<AcpCallerOptions, "defaultTimeoutMs" | "auditEnabled">>;

  constructor(options: AcpCallerOptions = {}) {
    this.options = {
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      auditEnabled: options.auditEnabled ?? true,
    };
  }

  async call(request: AcpRequest): Promise<AcpResponse> {
    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs;

    const maxAttempts = request.retryPolicy?.maxAttempts ?? 1;
    const backoffMs = request.retryPolicy?.backoffMs ?? 500;
    const backoffMultiplier = request.retryPolicy?.backoffMultiplier ?? 2;

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this._executeWithTimeout(request, timeoutMs);
        const latencyMs = Date.now() - startedAt;
        return {
          traceId: request.traceId,
          status: "success",
          errorCode: null,
          latencyMs,
          outputSchemaVersion: "1.0",
          result,
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (lastError.name === "TimeoutError") {
          return {
            traceId: request.traceId,
            status: "timeout",
            errorCode: ACP_ERROR_CODES.TIMEOUT,
            // 监控复盘 #3：超时也带 detail，区分 "网络/上游慢" vs "我们 timeoutMs 设太小"
            errorDetail: lastError.message.slice(0, 800),
            latencyMs: timeoutMs,
            outputSchemaVersion: "1.0",
            result: null,
          };
        }

        if (attempt < maxAttempts) {
          const delay = backoffMs * Math.pow(backoffMultiplier, attempt - 1);
          await Bun.sleep(delay);
        }
      }
    }

    const finalLatency = Date.now() - startedAt;
    return {
      traceId: request.traceId,
      status: "error",
      errorCode: ACP_ERROR_CODES.CONNECTOR_ERROR,
      // 监控复盘 #3：最后一次 attempt 的 err.message 透传给 act.ts → 拼到 errorMessage 里给 LLM。
      // 现状（修复前）：LLM 只看到 "ACP_CONNECTOR_ERROR"，无法分辨参数错 / 上游 500 / connector 内部异常。
      // 实测 fetch_klines 5 次失败 + version_strategy 2 次失败全部因为 LLM 看不到 detail 而盲重试。
      errorDetail: lastError?.message?.slice(0, 800) ?? null,
      latencyMs: finalLatency,
      outputSchemaVersion: "1.0",
      result: null,
    };
  }

  private async _executeWithTimeout(request: AcpRequest, timeoutMs: number): Promise<unknown> {
    // Connector dispatch is resolved by the ConnectorRegistry (wired externally)
    const execution = this._dispatch(request);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => {
        const err = new Error(`ACP timeout after ${timeoutMs}ms`);
        err.name = "TimeoutError";
        reject(err);
      }, timeoutMs)
    );
    return Promise.race([execution, timeout]);
  }

  private async _dispatch(request: AcpRequest): Promise<unknown> {
    // Resolved by ConnectorRegistry at runtime
    const registry = await import("../connectors/registry");
    return registry.dispatchAcpCall(request);
  }
}

// ─── Factory helpers ──────────────────────────────────────────────────────────

export function buildAcpRequest(partial: Omit<AcpRequest, "traceId">): AcpRequest {
  return {
    traceId: randomUUID(),
    ...partial,
  };
}

export const defaultAcpCaller = new AcpCaller();
