import { randomUUID } from "node:crypto";
import type { AcpRequest, AcpResponse } from "../types/acp";
import { ACP_ERROR_CODES } from "../types/acp";
import type { Connector } from "../types/connector";

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
 */
export class AcpCaller {
  private options: Required<AcpCallerOptions>;

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

    return {
      traceId: request.traceId,
      status: "error",
      errorCode: ACP_ERROR_CODES.CONNECTOR_ERROR,
      latencyMs: Date.now() - startedAt,
      outputSchemaVersion: "1.0",
      result: null,
    };
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
