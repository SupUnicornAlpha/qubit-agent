/**
 * P0-4 W1 mini-fix：tool 错误分类 + 重试提示。act.ts MCP catch 路径用此模块给
 * observation 加结构化 errorClass / retryable / hint，让下一轮 LLM 能基于此换
 * 工具/换参而不是反复重试同一个错。
 */
import { describe, expect, test } from "bun:test";
import {
  buildMcpRetryHint,
  classifyToolError,
} from "../tool-error-classifier";

describe("classifyToolError", () => {
  test("识别 transient 错误（timeout / 5xx / 429 / abort / 子进程退出）", () => {
    expect(classifyToolError("MCP RPC timeout waiting for id=...")).toBe("transient");
    expect(classifyToolError("MCP HTTP 503: Service Unavailable")).toBe("transient");
    expect(classifyToolError("MCP HTTP 429: rate limited")).toBe("transient");
    expect(classifyToolError("AbortError: signal aborted")).toBe("transient");
    expect(classifyToolError("python-bridge[X] subprocess exited unexpectedly (code=1)")).toBe(
      "transient"
    );
    expect(classifyToolError("stream closed")).toBe("transient");
    expect(classifyToolError("Connection refused (ECONNREFUSED)")).toBe("transient");
  });

  test("识别 permanent 错误（4xx / 参数错 / 资源 not found）", () => {
    expect(classifyToolError("MCP HTTP 400: bad request")).toBe("permanent");
    expect(classifyToolError("validation_failed: 'ticker' required missing")).toBe("permanent");
    expect(classifyToolError("invalid argument: end < start")).toBe("permanent");
    expect(classifyToolError("symbol AAPL not_found in provider universe")).toBe("permanent");
    expect(classifyToolError("MCP HTTP 401: unauthorized")).toBe("permanent");
  });

  test("识别 blocked 错误（沙箱 / 熔断 / disabled）", () => {
    expect(classifyToolError("sandbox denied tool call: not in allow list")).toBe("blocked");
    expect(classifyToolError("circuit breaker open for mcp:xxx:yyy")).toBe("blocked");
    expect(classifyToolError("mcp tool binding disabled: news/get_headlines")).toBe("blocked");
  });

  test("无匹配模式归 unknown（保守不重试）", () => {
    expect(classifyToolError("")).toBe("unknown");
    expect(classifyToolError("something weird happened")).toBe("unknown");
  });
});

describe("buildMcpRetryHint", () => {
  test("transient → 提示自动重试过 + 换数据源建议", () => {
    const hint = buildMcpRetryHint("transient", "MCP HTTP 503", "news/get_headlines");
    expect(hint).toContain("瞬时错误");
    expect(hint).toContain("news/get_headlines");
    expect(hint).toContain("MCP HTTP 503");
  });

  test("permanent → 提示不可重试 + 修参数建议", () => {
    const hint = buildMcpRetryHint("permanent", "validation_failed", "factor/run");
    expect(hint).toContain("不可重试");
    expect(hint).toContain("修正参数");
  });

  test("blocked → 提示换工具或退化文字推理", () => {
    const hint = buildMcpRetryHint("blocked", "sandbox denied", "web/search");
    expect(hint).toContain("沙箱或熔断");
    expect(hint).toContain("退化");
  });

  test("unknown → 保守提示不要反复重试", () => {
    const hint = buildMcpRetryHint("unknown", "weird", "x/y");
    expect(hint).toContain("无法判断");
    expect(hint).toContain("不要反复重试");
  });

  test("长 message 自动截断到 200 字符", () => {
    const long = "a".repeat(500);
    const hint = buildMcpRetryHint("transient", long, "x/y");
    expect(hint).toContain("…");
    expect(hint.length).toBeLessThan(500);
  });
});
