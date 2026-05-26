import { describe, expect, test } from "bun:test";
import {
  accumulateCounter,
  calcQualityScore,
  counterMapToObject,
  parseBreakdownJson,
  percentile,
  topNErrors,
} from "./quality-metrics";

describe("percentile", () => {
  test("returns null for empty input", () => {
    expect(percentile([], 50)).toBeNull();
  });

  test("computes p50 for odd-length samples", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });
});

describe("calcQualityScore", () => {
  test("perfect run stays near 1", () => {
    expect(calcQualityScore({ totalToolCalls: 0, sandboxBlockCount: 0, errorCount: 0 })).toBe(1);
  });

  test("errors and sandbox blocks reduce score", () => {
    const score = calcQualityScore({
      totalToolCalls: 40,
      sandboxBlockCount: 2,
      errorCount: 3,
    });
    expect(score).toBeLessThan(0.75);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

// ──────────────────────── breakdown helpers (P0-3) ────────────────────────

describe("accumulateCounter + counterMapToObject (byTool/byMcp 拆分)", () => {
  test("count / error / avgLatency 三项口径一致", () => {
    const bucket = new Map<string, { count: number; error: number; latencies: number[] }>();
    accumulateCounter(bucket, "place_order", { status: "success", latencyMs: 100 });
    accumulateCounter(bucket, "place_order", { status: "error", latencyMs: 300 });
    accumulateCounter(bucket, "place_order", { status: "timeout", latencyMs: 800 });
    accumulateCounter(bucket, "fetch_quote", { status: "success", latencyMs: null });

    const obj = counterMapToObject(bucket);
    expect(obj.place_order).toEqual({ count: 3, error: 2, avgLatencyMs: 400 });
    expect(obj.fetch_quote).toEqual({ count: 1, error: 0, avgLatencyMs: null });
  });

  test("status='failed' 视为错误（MCP 调用路径）", () => {
    const bucket = new Map<string, { count: number; error: number; latencies: number[] }>();
    accumulateCounter(bucket, "datadog.search_logs", { status: "failed", latencyMs: 200 });
    accumulateCounter(bucket, "datadog.search_logs", { status: "success", latencyMs: 200 });
    expect(counterMapToObject(bucket)["datadog.search_logs"]).toEqual({
      count: 2,
      error: 1,
      avgLatencyMs: 200,
    });
  });
});

describe("topNErrors", () => {
  test("按 count 降序，截断到 N", () => {
    const bucket = new Map<string, number>([
      ["timeout", 5],
      ["503 upstream", 2],
      ["ECONNRESET", 8],
      ["sandbox_blocked", 1],
    ]);
    expect(topNErrors(bucket, 2)).toEqual([
      { message: "ECONNRESET", count: 8 },
      { message: "timeout", count: 5 },
    ]);
  });
});

describe("parseBreakdownJson", () => {
  test("空对象与异常输入降级为空 breakdown 骨架", () => {
    expect(parseBreakdownJson("{}")).toEqual({ byTool: {}, byMcp: {}, bySkill: {}, errorTopN: [] });
    expect(parseBreakdownJson(null)).toEqual({ byTool: {}, byMcp: {}, bySkill: {}, errorTopN: [] });
    expect(parseBreakdownJson("not json")).toEqual({ byTool: {}, byMcp: {}, bySkill: {}, errorTopN: [] });
  });

  test("已 parse 的对象直接透传四个字段", () => {
    const obj = {
      byTool: { foo: { count: 2, error: 0, avgLatencyMs: 100 } },
      byMcp: {},
      bySkill: { "skill-x": { count: 3, fail: 1 } },
      errorTopN: [{ message: "boom", count: 2 }],
    };
    expect(parseBreakdownJson(obj)).toEqual(obj);
  });

  test("字符串形态 JSON 也能解析（兜底，正常路径 drizzle 已解析为对象）", () => {
    const raw = JSON.stringify({
      byTool: {},
      byMcp: {},
      bySkill: {},
      errorTopN: [{ message: "x", count: 1 }],
    });
    expect(parseBreakdownJson(raw).errorTopN[0]).toEqual({ message: "x", count: 1 });
  });
});
