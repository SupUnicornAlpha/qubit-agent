/**
 * P1：MCP 熔断状态机决策函数回归测试。
 *
 * 覆盖 4 个核心分支：
 *   1) success：永远转 closed，failure_count=0，success_count+1
 *   2) failure & wasHalfOpen：直接 open（探测失败）
 *   3) failure & failure_count+1 >= threshold：open
 *   4) failure & 未达阈值：维持当前状态，failure_count++
 *
 * 不依赖 DB / drizzle —— 纯函数级测试。
 */
import { describe, expect, test } from "bun:test";
import {
  computeNextHealthDecision,
  type CurrentHealthState,
} from "../mcp-health-tracker";

const baseClosed: CurrentHealthState = {
  circuitState: "closed",
  failureCount: 0,
  successCount: 5,
  openedAt: null,
  cooldownMs: 30_000,
};

describe("computeNextHealthDecision · success 分支", () => {
  test("从 closed 接收 success：归零 failure，success+1", () => {
    const d = computeNextHealthDecision(baseClosed, "success");
    expect(d.nextState).toBe("closed");
    expect(d.reopen).toBe(false);
    expect(d.nextFailureCount).toBe(0);
    expect(d.nextSuccessCount).toBe(6);
  });

  test("从 half_open 接收 success：回到 closed", () => {
    const d = computeNextHealthDecision(
      { ...baseClosed, circuitState: "half_open", failureCount: 2 },
      "success"
    );
    expect(d.nextState).toBe("closed");
    expect(d.nextFailureCount).toBe(0);
  });

  test("从 open 接收 success：直接归 closed（理论上 assert 会拦截，但有 race 兜底）", () => {
    const d = computeNextHealthDecision(
      { ...baseClosed, circuitState: "open", failureCount: 0, openedAt: "2026-01-01T00:00:00Z" },
      "success"
    );
    expect(d.nextState).toBe("closed");
  });
});

describe("computeNextHealthDecision · failure 分支", () => {
  test("closed + failure（未达阈值）：维持 closed，failure+1", () => {
    const d = computeNextHealthDecision(baseClosed, "failed");
    expect(d.nextState).toBe("closed");
    expect(d.reopen).toBe(false);
    expect(d.nextFailureCount).toBe(1);
  });

  test("closed + failure（达阈值）：转 open，归零计数为下轮 half_open 备用", () => {
    const d = computeNextHealthDecision(
      { ...baseClosed, failureCount: 2 },
      "failed"
    );
    expect(d.nextState).toBe("open");
    expect(d.reopen).toBe(true);
    expect(d.nextFailureCount).toBe(0);
  });

  test("half_open + failure：直接 open（探测失败），无需累计", () => {
    const d = computeNextHealthDecision(
      { ...baseClosed, circuitState: "half_open", failureCount: 0 },
      "failed"
    );
    expect(d.nextState).toBe("open");
    expect(d.reopen).toBe(true);
  });

  test("timeout 与 failed / sandbox_blocked 等同对待（都属于失败）", () => {
    const d1 = computeNextHealthDecision({ ...baseClosed, failureCount: 2 }, "timeout");
    expect(d1.nextState).toBe("open");
    const d2 = computeNextHealthDecision(
      { ...baseClosed, failureCount: 2 },
      "sandbox_blocked"
    );
    expect(d2.nextState).toBe("open");
  });
});

describe("computeNextHealthDecision · 自定义 threshold", () => {
  test("传入 threshold=1：一次失败就直接 open", () => {
    const d = computeNextHealthDecision(baseClosed, "failed", 1);
    expect(d.nextState).toBe("open");
    expect(d.reopen).toBe(true);
  });

  test("传入 threshold=10：默认 3 次失败也不会 open", () => {
    const d = computeNextHealthDecision({ ...baseClosed, failureCount: 2 }, "failed", 10);
    expect(d.nextState).toBe("closed");
    expect(d.reopen).toBe(false);
    expect(d.nextFailureCount).toBe(3);
  });
});
