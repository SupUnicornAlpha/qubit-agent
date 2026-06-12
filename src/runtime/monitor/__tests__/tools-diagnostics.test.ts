/**
 * tools-diagnostics 纯函数单测（不依赖 sqlite）。
 *
 * 覆盖：
 *   - aggregateSummary 各 status 分桶 + lastCalledAt 选最新
 *   - computeLatencyPercentiles：p50/p95/p99 边界
 *   - normalizeErrorMessage：UUID / 时间戳 / 长数字 mask
 *   - aggregateErrorTop：同类错误合并 + 按 count 降序 + lastSeen 取最新
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateErrorTop,
  aggregateSummary,
  computeLatencyPercentiles,
  normalizeErrorMessage,
} from "../tools-diagnostics";

type Row = Parameters<typeof aggregateSummary>[1][number];

const row = (overrides: Partial<Row> = {}): Row => ({
  status: "success",
  latencyMs: 100,
  errorMessage: null,
  workflowRunId: "wf-1",
  createdAt: "2026-05-26T10:00:00Z",
  toolKind: "builtin",
  ...overrides,
});

describe("aggregateSummary", () => {
  test("空输入 → 0 totalCalls / successRate 0 / null lastCalledAt", () => {
    const r = aggregateSummary("foo", []);
    expect(r.totalCalls).toBe(0);
    expect(r.successRate).toBe(0);
    expect(r.lastCalledAt).toBeNull();
    expect(r.avgLatencyMs).toBeNull();
  });

  test("各 status 正确分桶", () => {
    const r = aggregateSummary("foo", [
      row({ status: "success" }),
      row({ status: "success" }),
      row({ status: "error" }),
      row({ status: "timeout" }),
      row({ status: "sandbox_blocked" }),
    ]);
    expect(r.totalCalls).toBe(5);
    expect(r.successCount).toBe(2);
    expect(r.errorCount).toBe(1);
    expect(r.timeoutCount).toBe(1);
    expect(r.sandboxBlockedCount).toBe(1);
    expect(r.successRate).toBe(0.4);
  });

  test("avgLatencyMs 仅统计 typeof 'number' 的样本", () => {
    const r = aggregateSummary("foo", [
      row({ latencyMs: 100 }),
      row({ latencyMs: 300 }),
      row({ latencyMs: null }),
    ]);
    expect(r.avgLatencyMs).toBe(200);
  });

  test("治理 #4：sandbox_blocked 的假 latency 不计入 avg", () => {
    const r = aggregateSummary("foo", [
      row({ status: "success", latencyMs: 100 }),
      row({ status: "success", latencyMs: 300 }),
      // recordToolCallStart 乐观初始化 latencyMs=1，blocked 终态不覆盖 → 假 1ms
      row({ status: "sandbox_blocked", latencyMs: 1 }),
    ]);
    // 若计入会被拽成 (100+300+1)/3≈133.67；排除后应为 200
    expect(r.avgLatencyMs).toBe(200);
    expect(r.sandboxBlockedCount).toBe(1);
  });

  test("lastCalledAt 取最大值（不依赖输入顺序）", () => {
    const r = aggregateSummary("foo", [
      row({ createdAt: "2026-05-26T08:00:00Z" }),
      row({ createdAt: "2026-05-26T12:00:00Z" }),
      row({ createdAt: "2026-05-26T10:00:00Z" }),
    ]);
    expect(r.lastCalledAt).toBe("2026-05-26T12:00:00Z");
  });

  test("toolKind 从行内继承（取最后看到的）", () => {
    const r = aggregateSummary("foo", [
      row({ toolKind: "skill" }),
      row({ toolKind: "mcp" }),
    ]);
    expect(r.toolKind).toBe("mcp");
  });
});

describe("computeLatencyPercentiles", () => {
  test("空样本 → 全 null + samples=0", () => {
    const r = computeLatencyPercentiles([]);
    expect(r.p50).toBeNull();
    expect(r.p95).toBeNull();
    expect(r.p99).toBeNull();
    expect(r.samples).toBe(0);
  });

  test("单样本 → 三个分位都等于该值", () => {
    const r = computeLatencyPercentiles([row({ latencyMs: 100 })]);
    expect(r.p50).toBe(100);
    expect(r.p95).toBe(100);
    expect(r.p99).toBe(100);
    expect(r.samples).toBe(1);
  });

  test("1..100 的均匀样本：p50 ≈ 50.5", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row({ latencyMs: i + 1 }));
    const r = computeLatencyPercentiles(rows);
    expect(r.p50).toBeCloseTo(50.5, 1);
    expect(r.p95).toBeCloseTo(95.05, 1);
    expect(r.p99).toBeCloseTo(99.01, 1);
    expect(r.samples).toBe(100);
  });

  test("负数 latency 被过滤", () => {
    const r = computeLatencyPercentiles([
      row({ latencyMs: -1 }),
      row({ latencyMs: 50 }),
      row({ latencyMs: 100 }),
    ]);
    expect(r.samples).toBe(2);
    expect(r.p50).toBe(75);
  });

  test("治理 #4：sandbox_blocked 的假 1ms 不进分位样本", () => {
    const r = computeLatencyPercentiles([
      row({ status: "sandbox_blocked", latencyMs: 1 }),
      row({ status: "success", latencyMs: 50 }),
      row({ status: "success", latencyMs: 100 }),
    ]);
    // 只剩 [50,100] 两个真实样本，1ms 被排除
    expect(r.samples).toBe(2);
    expect(r.p50).toBe(75);
  });
});

describe("normalizeErrorMessage", () => {
  test("null / 空 → '(empty)'", () => {
    expect(normalizeErrorMessage(null)).toBe("(empty)");
  });

  test("UUID 被替换为 <uuid>", () => {
    const s = normalizeErrorMessage(
      "Tool call failed for run a1b2c3d4-e5f6-7890-abcd-1234567890ab in workflow"
    );
    expect(s).toContain("<uuid>");
    expect(s).not.toContain("a1b2c3d4");
  });

  test("ISO 时间戳被替换为 <ts>", () => {
    const s = normalizeErrorMessage("Timed out at 2026-05-26T10:00:00.123Z while connecting");
    expect(s).toContain("<ts>");
    expect(s).not.toContain("2026-05-26T");
  });

  test("8+ 位纯数字被替换为 <num>", () => {
    const s = normalizeErrorMessage("Order 123456789012 not found");
    expect(s).toContain("<num>");
    expect(s).not.toContain("123456789012");
  });

  test("过长消息截断为 240 + …", () => {
    const long = "x".repeat(300);
    const s = normalizeErrorMessage(long);
    expect(s.length).toBe(241);
    expect(s.endsWith("…")).toBe(true);
  });
});

describe("aggregateErrorTop", () => {
  test("跳过 success 行", () => {
    const r = aggregateErrorTop(
      [
        row({ status: "success", errorMessage: "ignored" }),
        row({ status: "error", errorMessage: "boom" }),
      ],
      10
    );
    expect(r.length).toBe(1);
    expect(r[0]?.errorMessage).toBe("boom");
  });

  test("不同 UUID 但同 root cause 应合并", () => {
    const r = aggregateErrorTop(
      [
        row({
          status: "error",
          errorMessage: "Task a1b2c3d4-e5f6-7890-abcd-1234567890ab failed",
        }),
        row({
          status: "error",
          errorMessage: "Task ffffffff-ffff-ffff-ffff-ffffffffffff failed",
        }),
      ],
      10
    );
    expect(r.length).toBe(1);
    expect(r[0]?.count).toBe(2);
    expect(r[0]?.errorMessage).toContain("<uuid>");
  });

  test("按 count 降序排列", () => {
    const r = aggregateErrorTop(
      [
        row({ status: "error", errorMessage: "rare" }),
        row({ status: "error", errorMessage: "common" }),
        row({ status: "error", errorMessage: "common" }),
        row({ status: "error", errorMessage: "common" }),
      ],
      10
    );
    expect(r[0]?.errorMessage).toBe("common");
    expect(r[0]?.count).toBe(3);
    expect(r[1]?.errorMessage).toBe("rare");
  });

  test("lastSeenAt 取该组最大 createdAt", () => {
    const r = aggregateErrorTop(
      [
        row({ status: "error", errorMessage: "same", createdAt: "2026-05-26T08:00:00Z" }),
        row({ status: "error", errorMessage: "same", createdAt: "2026-05-26T12:00:00Z" }),
        row({ status: "error", errorMessage: "same", createdAt: "2026-05-26T10:00:00Z" }),
      ],
      10
    );
    expect(r[0]?.lastSeenAt).toBe("2026-05-26T12:00:00Z");
  });

  test("limit 截断", () => {
    const rows = ["a", "b", "c", "d", "e"].map((m) =>
      row({ status: "error", errorMessage: m })
    );
    expect(aggregateErrorTop(rows, 2).length).toBe(2);
  });

  test("errorMessage 为 null → 归 '(empty)' 桶", () => {
    const r = aggregateErrorTop(
      [
        row({ status: "error", errorMessage: null }),
        row({ status: "error", errorMessage: null }),
      ],
      10
    );
    expect(r[0]?.errorMessage).toBe("(empty)");
    expect(r[0]?.count).toBe(2);
  });
});
