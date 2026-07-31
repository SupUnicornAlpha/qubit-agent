import { describe, expect, test } from "bun:test";
import {
  buildToolCallFingerprint,
  findReusableSuccessfulToolCall,
  resolveToolCallCachePolicy,
  shouldTerminateForNoProgress,
} from "./tool-call-dedup";

describe("tool call deduplication", () => {
  test("normalizes object key order and ignores runtime context ids", () => {
    const first = buildToolCallFingerprint({
      targetName: "qubit-data/fetch_klines",
      params: { symbol: "AAPL", limit: 60, workflowRunId: "wf-one" },
    });
    const second = buildToolCallFingerprint({
      targetName: "qubit-data/fetch_klines",
      params: { limit: 60, projectId: "project-two", symbol: "AAPL" },
    });
    expect(second).toBe(first);
  });

  test("reuses immutable successful reads but never mutating tools", () => {
    const fingerprint = buildToolCallFingerprint({
      targetName: "market.resolve_symbol",
      params: { symbol: "AAPL" },
    });
    const call = {
      toolName: "market.resolve_symbol",
      status: "success",
      fingerprint,
      completedAt: 100,
    };
    expect(
      findReusableSuccessfulToolCall({
        targetName: "market.resolve_symbol",
        fingerprint,
        priorToolCalls: [call],
        now: 1_000_000,
      })
    ).toEqual(call);
    expect(resolveToolCallCachePolicy("factor.register").cacheable).toBe(false);
  });

  test("allows a fresh quote after its short TTL", () => {
    const fingerprint = buildToolCallFingerprint({
      targetName: "qubit-data/fetch_quote",
      params: { symbol: "600519.SH" },
    });
    const call = {
      toolName: "qubit-data/fetch_quote",
      status: "success",
      fingerprint,
      completedAt: 100,
    };
    expect(
      findReusableSuccessfulToolCall({
        targetName: "qubit-data/fetch_quote",
        fingerprint,
        priorToolCalls: [call],
        now: 10_000,
      })
    ).toEqual(call);
    expect(
      findReusableSuccessfulToolCall({
        targetName: "qubit-data/fetch_quote",
        fingerprint,
        priorToolCalls: [call],
        now: 20_000,
      })
    ).toBeNull();
  });

  test("stops only after two consecutive no-progress reuses", () => {
    expect(shouldTerminateForNoProgress(1)).toBe(false);
    expect(shouldTerminateForNoProgress(2)).toBe(true);
  });
});
