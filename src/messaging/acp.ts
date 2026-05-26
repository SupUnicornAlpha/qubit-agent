import { randomUUID } from "node:crypto";
import type { AcpRequest, AcpResponse } from "../types/acp";
import { ACP_ERROR_CODES } from "../types/acp";
import type { Connector } from "../types/connector";

export interface AcpCallerOptions {
  defaultTimeoutMs?: number;
  auditEnabled?: boolean;
  /**
   * 监控 V2 P2 — 调用后回调（成功 / 失败 / timeout 均会触发）。
   *
   * 注入式 hook：避免让 messaging/acp.ts 直接 import sqlite / runtime/monitor 造成循环依赖；
   * 由调用方（runtime 启动期）注册：见 src/runtime/monitor/acp-monitoring-hook.ts。
   * Hook 内部失败必须自己 try/catch — 这里**不**捕获 hook 抛错。
   */
  onCallObserved?: (event: AcpCallObservedEvent) => void | Promise<void>;
}

/**
 * AcpCaller 调用观测事件：成功 / 失败 / timeout 三种结局都会派发。
 * 字段含义：
 *   - request：原始 AcpRequest（含 traceId / workflowId / targetKind / payload 等）
 *   - response：成功时返回的 AcpResponse；失败时 null（status 字段还能区分）
 *   - resultPayload：成功时 connector 返回的实际数据（response.result）
 *   - latencyMs：实际耗时（含 timeout 触发的 timeoutMs）
 *   - status：success / error / timeout / blocked（与 AcpResponse.status 同义）
 *   - errorMessage：失败时的 error message 摘要
 */
export type AcpCallObservedEvent = {
  request: AcpRequest;
  response: AcpResponse | null;
  resultPayload: unknown;
  latencyMs: number;
  status: AcpResponse["status"];
  errorMessage?: string;
};

/**
 * ACP (Agent Communication Protocol) caller.
 *
 * Wraps all outbound capability calls (skills, tools, connectors) with:
 * - Timeout enforcement
 * - Retry with exponential backoff
 * - Latency measurement
 * - Error normalization
 * - Audit logging (stub, wired in V1 implementation)
 */
export class AcpCaller {
  private options: Required<Pick<AcpCallerOptions, "defaultTimeoutMs" | "auditEnabled">> & {
    onCallObserved: ((event: AcpCallObservedEvent) => void | Promise<void>) | null;
  };

  constructor(options: AcpCallerOptions = {}) {
    this.options = {
      defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
      auditEnabled: options.auditEnabled ?? true,
      onCallObserved: options.onCallObserved ?? null,
    };
  }

  /** 监控 V2 P2：运行时由 connector-acp-logger 注入 hook；可重复调用覆盖。 */
  setOnCallObserved(
    hook: ((event: AcpCallObservedEvent) => void | Promise<void>) | null
  ): void {
    this.options.onCallObserved = hook;
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
        const response: AcpResponse = {
          traceId: request.traceId,
          status: "success",
          errorCode: null,
          latencyMs,
          outputSchemaVersion: "1.0",
          result,
        };
        await this._observe({ request, response, resultPayload: result, latencyMs, status: "success" });
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (lastError.name === "TimeoutError") {
          const response: AcpResponse = {
            traceId: request.traceId,
            status: "timeout",
            errorCode: ACP_ERROR_CODES.TIMEOUT,
            latencyMs: timeoutMs,
            outputSchemaVersion: "1.0",
            result: null,
          };
          await this._observe({
            request,
            response,
            resultPayload: null,
            latencyMs: timeoutMs,
            status: "timeout",
            errorMessage: lastError.message,
          });
          return response;
        }

        if (attempt < maxAttempts) {
          const delay = backoffMs * Math.pow(backoffMultiplier, attempt - 1);
          await Bun.sleep(delay);
        }
      }
    }

    const finalLatency = Date.now() - startedAt;
    const response: AcpResponse = {
      traceId: request.traceId,
      status: "error",
      errorCode: ACP_ERROR_CODES.CONNECTOR_ERROR,
      latencyMs: finalLatency,
      outputSchemaVersion: "1.0",
      result: null,
    };
    await this._observe({
      request,
      response,
      resultPayload: null,
      latencyMs: finalLatency,
      status: "error",
      ...(lastError ? { errorMessage: lastError.message } : {}),
    });
    return response;
  }

  /**
   * 派发观测事件。Hook 内自负责 try/catch；这里只兜底打 warn 避免把 hook 异常带回主链路。
   */
  private async _observe(event: AcpCallObservedEvent): Promise<void> {
    const hook = this.options.onCallObserved;
    if (!hook) return;
    try {
      await hook(event);
    } catch (e) {
      console.warn(
        `[AcpCaller] onCallObserved hook threw (ignored): ${(e as Error).message}`
      );
    }
  }

  private async _executeWithTimeout(
    request: AcpRequest,
    timeoutMs: number
  ): Promise<unknown> {
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

export function buildAcpRequest(
  partial: Omit<AcpRequest, "traceId">
): AcpRequest {
  return {
    traceId: randomUUID(),
    ...partial,
  };
}

export const defaultAcpCaller = new AcpCaller();
