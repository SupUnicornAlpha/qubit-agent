import { describe, expect, test } from "bun:test";
import { buildToolRecoveryPlan } from "../tool-recovery-policy";
import {
  recordWorkflowToolFailure,
  resetToolGovernanceCacheForTest,
} from "../../../tools/tool-governance-policy";

describe("buildToolRecoveryPlan", () => {
  test("allows exactly one retry for a first transient failure", () => {
    const plan = buildToolRecoveryPlan({
      failedTool: "fetch_klines",
      availableTools: ["fetch_klines", "fetch_quote"],
      priorToolCalls: [],
      errorClass: "transient",
      semanticFailure: false,
    });
    expect(plan.nextAction).toBe("retry_once");
    expect(plan.allowSameToolRetry).toBe(true);
  });

  test("switches after the transient retry budget is exhausted", () => {
    const plan = buildToolRecoveryPlan({
      failedTool: "fetch_klines",
      availableTools: ["fetch_klines", "fetch_quote"],
      priorToolCalls: [{ toolName: "fetch_klines", status: "failed" }],
      errorClass: "transient",
      semanticFailure: false,
    });
    expect(plan.allowSameToolRetry).toBe(false);
    expect(plan.nextAction).not.toBe("retry_once");
  });

  test("empty data never retries the same source", () => {
    const plan = buildToolRecoveryPlan({
      failedTool: "fetch_klines",
      availableTools: ["fetch_klines"],
      priorToolCalls: [],
      errorClass: "unknown",
      semanticFailure: true,
    });
    expect(plan.nextAction).toBe("continue_with_limits");
    expect(plan.guidance).toContain("条件式结论");
  });

  test("does not recommend another tool backed by a negatively cached provider", () => {
    resetToolGovernanceCacheForTest();
    recordWorkflowToolFailure({
      workflowId: "wf",
      targetName: "qubit-data/fetch_klines",
      params: { symbol: "603986.SH" },
      reason: "no data",
      cacheable: true,
    });
    const plan = buildToolRecoveryPlan({
      failedTool: "fetch_klines",
      availableTools: ["fetch_klines", "fetch_price_data"],
      priorToolCalls: [],
      errorClass: "unknown",
      semanticFailure: true,
      workflowId: "wf",
      params: { symbol: "603986.SH" },
    });
    expect(plan.alternatives).not.toContain("fetch_price_data");
    expect(plan.nextAction).toBe("continue_with_limits");
  });
});
