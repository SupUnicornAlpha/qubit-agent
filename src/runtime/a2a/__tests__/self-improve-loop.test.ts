/**
 * P2-A Batch 4：reflection / self-improve schema 契约测试。
 *
 * 不接 dispatcher / DB，纯 schema 与"派发参数构造"边界测试，确保后续接入
 * memory-consolidation / nightly cron 时形状不漂移。
 */

import { describe, expect, test } from "bun:test";
import {
  ReflectionRequestSchema,
  ReflectionScopeSchema,
} from "../self-improve-loop";

describe("ReflectionScopeSchema", () => {
  test("已知 scope 通过", () => {
    for (const s of [
      "workflow_completed",
      "workflow_failed",
      "daily_summary",
      "factor_retrain",
      "strategy_drift",
    ] as const) {
      expect(ReflectionScopeSchema.safeParse(s).success).toBe(true);
    }
  });

  test("未知 scope 被拒", () => {
    expect(ReflectionScopeSchema.safeParse("random_thoughts").success).toBe(false);
  });
});

describe("ReflectionRequestSchema", () => {
  test("最小合法输入：scope + subjectId", () => {
    const parsed = ReflectionRequestSchema.parse({
      scope: "workflow_completed",
      subjectId: "wf-1",
    });
    expect(parsed.attachToSubject).toBe(false);
    expect(parsed.severity).toBe("info");
    expect(parsed.context).toEqual({});
  });

  test("缺 subjectId 被拒", () => {
    expect(
      ReflectionRequestSchema.safeParse({ scope: "daily_summary" }).success,
    ).toBe(false);
  });

  test("空 subjectId 被拒", () => {
    expect(
      ReflectionRequestSchema.safeParse({
        scope: "daily_summary",
        subjectId: "",
      }).success,
    ).toBe(false);
  });

  test("完整输入透传", () => {
    const parsed = ReflectionRequestSchema.parse({
      scope: "strategy_drift",
      subjectId: "strategy-xyz",
      subjectLabel: "MA Crossover v2",
      targetRole: "portfolio_manager",
      attachToSubject: false,
      context: { ic_delta: -0.12 },
      severity: "warn",
      projectId: "p1",
    });
    expect(parsed.scope).toBe("strategy_drift");
    expect(parsed.subjectLabel).toBe("MA Crossover v2");
    expect(parsed.targetRole).toBe("portfolio_manager");
    expect((parsed.context as Record<string, unknown>).ic_delta).toBe(-0.12);
  });

  test("attachToSubject=true + workflow scope 时合法", () => {
    const parsed = ReflectionRequestSchema.parse({
      scope: "workflow_failed",
      subjectId: "wf-fail-1",
      attachToSubject: true,
    });
    expect(parsed.attachToSubject).toBe(true);
  });
});
