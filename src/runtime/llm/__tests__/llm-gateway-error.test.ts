import { describe, expect, test } from "bun:test";
import {
  classifyLlmGatewayError,
  extractHttpStatus,
  extractRetryAfterMs,
  isFallbackEligibleLlmGatewayError,
  isRetryableLlmGatewayError,
  LlmGatewayError,
} from "../llm-gateway-error";

describe("classifyLlmGatewayError", () => {
  test("maps 503 / busy to PROVIDER_BUSY and retryable", () => {
    const err = classifyLlmGatewayError(new Error("503 Service is too busy"));
    expect(err.code).toBe("PROVIDER_BUSY");
    expect(err.retryable).toBe(true);
    expect(err.fallbackEligible).toBe(true);
    expect(err.circuitRelevant).toBe(true);
    expect(err.httpStatus).toBe(503);
  });

  test("maps circuit open with retry-after hint", () => {
    const err = classifyLlmGatewayError(
      new Error("circuit breaker open: llm:deepseek:x (retry after ~21s)")
    );
    expect(err.code).toBe("CIRCUIT_OPEN");
    expect(err.retryAfterMs).toBe(21_000);
    expect(isRetryableLlmGatewayError(err)).toBe(true);
  });

  test("maps missing API key to AUTH (no fallback)", () => {
    const err = classifyLlmGatewayError(
      new Error("OPENAI_API_KEY is required for openai provider")
    );
    expect(err.code).toBe("AUTH");
    expect(err.retryable).toBe(false);
    expect(isFallbackEligibleLlmGatewayError(err)).toBe(false);
    expect(err.circuitRelevant).toBe(false);
  });

  test("maps socket reset to TRANSPORT", () => {
    const err = classifyLlmGatewayError(new Error("fetch failed: socket connection was closed"));
    expect(err.code).toBe("TRANSPORT");
    expect(err.retryable).toBe(true);
  });

  test("toLogLine is parse-friendly for terminal gates", () => {
    const err = new LlmGatewayError("PROVIDER_BUSY", "Service is too busy", {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      httpStatus: 503,
    });
    expect(err.toLogLine()).toContain("code=PROVIDER_BUSY");
    expect(err.toLogLine()).toContain("model=deepseek:deepseek-v4-flash");
  });

  test("extractHttpStatus from provider wrappers", () => {
    expect(extractHttpStatus("OpenAI-compatible request failed: 429 Too Many Requests")).toBe(
      429
    );
    expect(extractRetryAfterMs("circuit breaker open: x (retry after ~7s)")).toBe(7_000);
  });
});
