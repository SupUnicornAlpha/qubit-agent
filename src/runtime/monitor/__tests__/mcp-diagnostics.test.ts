/**
 * mcp-diagnostics 纯函数单测（不依赖 sqlite）。
 *
 * 覆盖：
 *   - aggregateSummary：'failed' status 桶（mcp_call_log 与 tool_call_log 状态枚举不一致）
 *   - aggregateErrorTop：errorCode 主键 + null code 归 '(failed)' / '(timeout)' 兜底
 *   - aggregateByTool：每 tool 失败分布与平均 latency
 *   - extractErrorMessageFromResponse：常见 MCP 错误结构
 */
import { describe, expect, test } from "bun:test";
import {
  aggregateByTool,
  aggregateErrorTop,
  aggregateSummary,
  extractErrorMessageFromResponse,
} from "../mcp-diagnostics";

type Row = Parameters<typeof aggregateSummary>[0][number];

const row = (overrides: Partial<Row> = {}): Row => ({
  status: "success",
  toolName: "search",
  errorCode: null,
  latencyMs: 100,
  workflowRunId: "wf-1",
  createdAt: "2026-05-26T10:00:00Z",
  responseJson: null,
  ...overrides,
});

describe("aggregateSummary (mcp)", () => {
  test("'failed' 进 failedCount，'timeout' 进 timeoutCount", () => {
    const r = aggregateSummary([
      row({ status: "success" }),
      row({ status: "failed" }),
      row({ status: "failed" }),
      row({ status: "timeout" }),
      row({ status: "sandbox_blocked" }),
    ]);
    expect(r.totalCalls).toBe(5);
    expect(r.successCount).toBe(1);
    expect(r.failedCount).toBe(2);
    expect(r.timeoutCount).toBe(1);
    expect(r.sandboxBlockedCount).toBe(1);
    expect(r.successRate).toBe(0.2);
  });

  test("空输入 → 0 totalCalls", () => {
    const r = aggregateSummary([]);
    expect(r.totalCalls).toBe(0);
    expect(r.successRate).toBe(0);
    expect(r.avgLatencyMs).toBeNull();
    expect(r.lastCalledAt).toBeNull();
  });
});

describe("aggregateErrorTop (mcp)", () => {
  test("按 errorCode 聚合 + 跳过 success", () => {
    const r = aggregateErrorTop(
      [
        row({ status: "success", errorCode: "ignored" }),
        row({ status: "failed", errorCode: "RPC_TIMEOUT" }),
        row({ status: "failed", errorCode: "RPC_TIMEOUT" }),
        row({ status: "failed", errorCode: "AUTH_FAILED" }),
      ],
      10
    );
    expect(r.length).toBe(2);
    expect(r[0]?.errorCode).toBe("RPC_TIMEOUT");
    expect(r[0]?.count).toBe(2);
  });

  test("errorCode 为 null → '(<status>)' 兜底", () => {
    const r = aggregateErrorTop(
      [
        row({ status: "failed", errorCode: null }),
        row({ status: "timeout", errorCode: null }),
      ],
      10
    );
    const keys = r.map((x) => x.errorCode).sort();
    expect(keys).toEqual(["(failed)", "(timeout)"]);
  });

  test("limit 截断", () => {
    const rows = ["A", "B", "C"].map((c) => row({ status: "failed", errorCode: c }));
    expect(aggregateErrorTop(rows, 2).length).toBe(2);
  });

  test("sampleMessage 从 responseJson 提取 + 时间戳被 mask", () => {
    const r = aggregateErrorTop(
      [
        row({
          status: "failed",
          errorCode: "RPC_TIMEOUT",
          responseJson: { error: { message: "Timed out at 2026-05-26T10:00:00.000Z" } },
        }),
      ],
      10
    );
    expect(r[0]?.sampleMessage).toContain("<ts>");
  });
});

describe("aggregateByTool (mcp)", () => {
  test("按 toolName 分桶 + 各 status 计数", () => {
    const r = aggregateByTool([
      row({ toolName: "search", status: "success" }),
      row({ toolName: "search", status: "failed" }),
      row({ toolName: "search", status: "timeout" }),
      row({ toolName: "fetch", status: "success" }),
      row({ toolName: "fetch", status: "sandbox_blocked" }),
    ]);
    expect(r.length).toBe(2);
    const search = r.find((x) => x.toolName === "search")!;
    const fetch = r.find((x) => x.toolName === "fetch")!;
    expect(search.totalCalls).toBe(3);
    expect(search.successCount).toBe(1);
    expect(search.failedCount).toBe(1);
    expect(search.timeoutCount).toBe(1);
    expect(fetch.sandboxBlockedCount).toBe(1);
  });

  test("avgLatencyMs 仅统计有 latency 的样本", () => {
    const r = aggregateByTool([
      row({ toolName: "search", latencyMs: 100 }),
      row({ toolName: "search", latencyMs: 300 }),
      row({ toolName: "search", latencyMs: null }),
    ]);
    expect(r[0]?.avgLatencyMs).toBe(200);
  });

  test("按 totalCalls 降序排列", () => {
    const r = aggregateByTool([
      row({ toolName: "rare" }),
      row({ toolName: "common" }),
      row({ toolName: "common" }),
      row({ toolName: "common" }),
    ]);
    expect(r[0]?.toolName).toBe("common");
    expect(r[1]?.toolName).toBe("rare");
  });
});

describe("extractErrorMessageFromResponse", () => {
  test("null / undefined → null", () => {
    expect(extractErrorMessageFromResponse(null)).toBeNull();
    expect(extractErrorMessageFromResponse(undefined)).toBeNull();
  });

  test("response.error.message 优先", () => {
    const s = extractErrorMessageFromResponse({
      error: { message: "rpc failed" },
      message: "fallback",
    });
    expect(s).toBe("rpc failed");
  });

  test("没有 error.message 时 fallback 到 .message", () => {
    const s = extractErrorMessageFromResponse({ message: "top level msg" });
    expect(s).toBe("top level msg");
  });

  test("error 是字符串：序列化 + normalize", () => {
    const s = extractErrorMessageFromResponse({ error: "bare string error" });
    expect(s).toContain("bare string error");
  });

  test("非字符串候选 → JSON.stringify + normalize", () => {
    const s = extractErrorMessageFromResponse({
      error: { code: 500, details: "internal" },
    });
    expect(s).toContain("500");
  });

  test("字符串型 response → normalize", () => {
    const s = extractErrorMessageFromResponse("just a string error at 2026-05-26T10:00:00Z");
    expect(s).toContain("<ts>");
  });
});
