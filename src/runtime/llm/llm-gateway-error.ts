/**
 * Structured LLM Gateway errors.
 *
 * Goal: classify provider/transport failures once, then let router/react/monitor
 * branch on stable codes instead of brittle message regexes.
 */

export type LlmGatewayErrorCode =
  | "AUTH"
  | "INVALID_REQUEST"
  | "RATE_LIMIT"
  | "PROVIDER_BUSY"
  | "TRANSPORT"
  | "TIMEOUT"
  | "CIRCUIT_OPEN"
  | "ABORTED"
  | "UNKNOWN";

export type LlmGatewayErrorJson = {
  name: "LlmGatewayError";
  code: LlmGatewayErrorCode;
  message: string;
  provider?: string;
  model?: string;
  httpStatus?: number;
  retryable: boolean;
  fallbackEligible: boolean;
  circuitRelevant: boolean;
  retryAfterMs?: number;
  attempt?: number;
  causeMessage?: string;
};

export class LlmGatewayError extends Error {
  readonly code: LlmGatewayErrorCode;
  readonly provider?: string;
  readonly model?: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly fallbackEligible: boolean;
  readonly circuitRelevant: boolean;
  readonly retryAfterMs?: number;
  readonly attempt?: number;

  constructor(
    code: LlmGatewayErrorCode,
    message: string,
    options?: {
      provider?: string;
      model?: string;
      httpStatus?: number;
      retryable?: boolean;
      fallbackEligible?: boolean;
      circuitRelevant?: boolean;
      retryAfterMs?: number;
      attempt?: number;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LlmGatewayError";
    this.code = code;
    if (options?.provider !== undefined) this.provider = options.provider;
    if (options?.model !== undefined) this.model = options.model;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    this.retryable = options?.retryable ?? defaultRetryable(code);
    this.fallbackEligible = options?.fallbackEligible ?? defaultFallbackEligible(code);
    this.circuitRelevant = options?.circuitRelevant ?? defaultCircuitRelevant(code);
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options?.attempt !== undefined) this.attempt = options.attempt;
  }

  static is(error: unknown): error is LlmGatewayError {
    return error instanceof LlmGatewayError;
  }

  toJSON(): LlmGatewayErrorJson {
    return {
      name: "LlmGatewayError",
      code: this.code,
      message: this.message,
      ...(this.provider !== undefined ? { provider: this.provider } : {}),
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      retryable: this.retryable,
      fallbackEligible: this.fallbackEligible,
      circuitRelevant: this.circuitRelevant,
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
      ...(this.attempt !== undefined ? { attempt: this.attempt } : {}),
      ...(this.cause instanceof Error ? { causeMessage: this.cause.message } : {}),
    };
  }

  /** Compact one-liner for llm_call_log / observe payloads. */
  toLogLine(): string {
    const bits = [
      `code=${this.code}`,
      this.provider && this.model ? `model=${this.provider}:${this.model}` : null,
      this.httpStatus !== undefined ? `http=${this.httpStatus}` : null,
      this.retryable ? "retryable" : "fatal",
      this.fallbackEligible ? "fallback_ok" : "no_fallback",
      this.retryAfterMs !== undefined ? `retryAfterMs=${this.retryAfterMs}` : null,
    ].filter(Boolean);
    return `LLM gateway error [${bits.join(" ")}]: ${this.message}`;
  }
}

function defaultRetryable(code: LlmGatewayErrorCode): boolean {
  return (
    code === "RATE_LIMIT" ||
    code === "PROVIDER_BUSY" ||
    code === "TRANSPORT" ||
    code === "TIMEOUT" ||
    code === "CIRCUIT_OPEN"
  );
}

function defaultFallbackEligible(code: LlmGatewayErrorCode): boolean {
  // Auth/invalid-request on primary is usually config; falling back just burns another key.
  return (
    code === "RATE_LIMIT" ||
    code === "PROVIDER_BUSY" ||
    code === "TRANSPORT" ||
    code === "TIMEOUT" ||
    code === "CIRCUIT_OPEN" ||
    code === "UNKNOWN"
  );
}

function defaultCircuitRelevant(code: LlmGatewayErrorCode): boolean {
  // Do not open the breaker on caller abort / bad config / validation.
  return (
    code === "RATE_LIMIT" ||
    code === "PROVIDER_BUSY" ||
    code === "TRANSPORT" ||
    code === "TIMEOUT" ||
    code === "UNKNOWN"
  );
}

const HTTP_STATUS_RE =
  /(?:request failed|failed|error)[:\s]+(\d{3})\b|\bHTTP[\/\s]?(\d{3})\b|\b(\d{3})\s+(?:Service|Too|Unauthorized|Forbidden|Bad|Gateway|Internal)/i;

export function extractHttpStatus(message: string): number | undefined {
  const m = message.match(HTTP_STATUS_RE);
  if (!m) return undefined;
  const raw = m[1] ?? m[2] ?? m[3];
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function extractRetryAfterMs(message: string): number | undefined {
  const sec = message.match(/retry after ~(\d+)\s*s/i);
  if (sec?.[1]) return Number(sec[1]) * 1000;
  const ms = message.match(/retry[_-]?after[=:\s]+(\d+)\s*ms/i);
  if (ms?.[1]) return Number(ms[1]);
  return undefined;
}

/**
 * Classify any thrown value into a structured gateway error.
 * Already-structured errors are enriched with provider/model if missing.
 */
export function classifyLlmGatewayError(
  error: unknown,
  context?: { provider?: string; model?: string; attempt?: number }
): LlmGatewayError {
  if (LlmGatewayError.is(error)) {
    if (
      (context?.provider && !error.provider) ||
      (context?.model && !error.model) ||
      (context?.attempt !== undefined && error.attempt === undefined)
    ) {
      return new LlmGatewayError(error.code, error.message, {
        provider: error.provider ?? context?.provider,
        model: error.model ?? context?.model,
        httpStatus: error.httpStatus,
        retryable: error.retryable,
        fallbackEligible: error.fallbackEligible,
        circuitRelevant: error.circuitRelevant,
        retryAfterMs: error.retryAfterMs,
        attempt: error.attempt ?? context?.attempt,
        cause: error.cause ?? error,
      });
    }
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const httpStatus = extractHttpStatus(message);
  const lower = message.toLowerCase();
  const base = {
    provider: context?.provider,
    model: context?.model,
    attempt: context?.attempt,
    httpStatus,
    cause: error,
  };

  if (
    (error instanceof Error && error.name === "AbortError") ||
    /\baborted\b|\bcancel(?:led|ed)?\b|workflow cancelled/i.test(message)
  ) {
    return new LlmGatewayError("ABORTED", message, {
      ...base,
      retryable: false,
      fallbackEligible: false,
      circuitRelevant: false,
    });
  }

  if (/\bcircuit breaker open\b/i.test(message)) {
    return new LlmGatewayError("CIRCUIT_OPEN", message, {
      ...base,
      retryAfterMs: extractRetryAfterMs(message),
    });
  }

  if (
    /api[_ ]?key is required|unauthorized|invalid[_ ]?api[_ ]?key|authentication|401\b|403\b/i.test(
      message
    ) ||
    httpStatus === 401 ||
    httpStatus === 403
  ) {
    return new LlmGatewayError("AUTH", message, { ...base, httpStatus: httpStatus ?? 401 });
  }

  if (
    /invalid[_ ]?request|bad request|unsupported|missing required|\b400\b|\b422\b/i.test(message) ||
    httpStatus === 400 ||
    httpStatus === 422
  ) {
    return new LlmGatewayError("INVALID_REQUEST", message, {
      ...base,
      httpStatus: httpStatus ?? 400,
    });
  }

  if (
    /rate limit|too many requests|\b429\b/i.test(message) ||
    httpStatus === 429
  ) {
    return new LlmGatewayError("RATE_LIMIT", message, {
      ...base,
      httpStatus: httpStatus ?? 429,
      retryAfterMs: extractRetryAfterMs(message) ?? 2_000,
    });
  }

  if (
    /service is too busy|provider.*busy|\b503\b|\b502\b|\b504\b|gateway timeout|bad gateway|overloaded/i.test(
      message
    ) ||
    httpStatus === 502 ||
    httpStatus === 503 ||
    httpStatus === 504
  ) {
    return new LlmGatewayError("PROVIDER_BUSY", message, {
      ...base,
      httpStatus: httpStatus ?? 503,
    });
  }

  if (/timed?\s*out|deadline exceeded|etimedout/i.test(message)) {
    return new LlmGatewayError("TIMEOUT", message, base);
  }

  if (
    /socket connection was closed|fetch failed|network error|econnreset|econnrefused|und_err|connection reset|eai_again/i.test(
      message
    )
  ) {
    return new LlmGatewayError("TRANSPORT", message, base);
  }

  return new LlmGatewayError("UNKNOWN", message, base);
}

export function isRetryableLlmGatewayError(error: unknown): boolean {
  return classifyLlmGatewayError(error).retryable;
}

export function isFallbackEligibleLlmGatewayError(error: unknown): boolean {
  return classifyLlmGatewayError(error).fallbackEligible;
}
