/**
 * P2-A Batch 3：自主 trigger 接口契约测试。
 *
 * 这里只测 schema + 分支选择两个边界（不接 DB / 真实 dispatcher），
 * 验证后续接入事件源时的"形状契约"不会偷偷漂移。
 */

import { describe, expect, test } from "bun:test";
import {
  AutonomousTriggerInputSchema,
  AutonomousTriggerKindSchema,
  AutonomousTriggerSeveritySchema,
} from "../autonomous-trigger";

describe("AutonomousTriggerKindSchema", () => {
  test("已知 kind 全部通过", () => {
    const known = [
      "market_alert",
      "news_event",
      "risk_breach",
      "model_update",
      "strategy_signal",
      "reflection_request",
      "custom",
    ] as const;
    for (const k of known) {
      expect(AutonomousTriggerKindSchema.safeParse(k).success).toBe(true);
    }
  });

  test("未知 kind 被拒", () => {
    expect(AutonomousTriggerKindSchema.safeParse("invalid_kind").success).toBe(
      false,
    );
  });
});

describe("AutonomousTriggerSeveritySchema", () => {
  test("info/warn/error/critical 通过；其他拒绝", () => {
    for (const s of ["info", "warn", "error", "critical"] as const) {
      expect(AutonomousTriggerSeveritySchema.safeParse(s).success).toBe(true);
    }
    expect(AutonomousTriggerSeveritySchema.safeParse("debug").success).toBe(false);
  });
});

describe("AutonomousTriggerInputSchema", () => {
  test("最小合法输入：kind + source", () => {
    const parsed = AutonomousTriggerInputSchema.parse({
      kind: "market_alert",
      source: "market_data_v2",
    });
    expect(parsed.severity).toBe("info");
    expect(parsed.payload).toEqual({});
  });

  test("缺 source 被拒", () => {
    const r = AutonomousTriggerInputSchema.safeParse({ kind: "market_alert" });
    expect(r.success).toBe(false);
  });

  test("空 source 被拒（min=1）", () => {
    const r = AutonomousTriggerInputSchema.safeParse({
      kind: "market_alert",
      source: "",
    });
    expect(r.success).toBe(false);
  });

  test("完整输入透传", () => {
    const parsed = AutonomousTriggerInputSchema.parse({
      kind: "risk_breach",
      source: "risk_engine",
      payload: { ticker: "AAPL", breach: 0.95 },
      targetRole: "risk_manager",
      workflowRunId: "wf-1",
      severity: "critical",
      message: "VAR breach 95%",
    });
    expect(parsed.kind).toBe("risk_breach");
    expect(parsed.severity).toBe("critical");
    expect(parsed.payload.ticker).toBe("AAPL");
    expect(parsed.targetRole).toBe("risk_manager");
  });
});
