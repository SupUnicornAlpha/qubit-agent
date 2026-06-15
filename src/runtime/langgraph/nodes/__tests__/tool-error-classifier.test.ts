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

  /*
   * 回归：本仓自产的子进程崩溃/断流消息是中文（stdio-session._formatStdioExitErrorMessage /
   * jsonrpc-ndjson collectRpcResponse），原 TRANSIENT_PATTERNS 只认英文
   * `subprocess exited`，导致这些中文消息被归 unknown(retryable=false)。实证中
   * mcp-financex 的 subprocess_exit 失败（10 次）本可重试却没重试。钉死为 transient。
   */
  test("中文子进程崩溃/断流（本仓自产）→ transient", () => {
    expect(
      classifyToolError("MCP stdio: 子进程在 tools/call 阶段提前退出 (exit code=1)")
    ).toBe("transient");
    expect(
      classifyToolError("MCP stdio: 子进程在 initialize 阶段提前退出 (exit code=?)")
    ).toBe("transient");
    // 带 [server/tool] 前缀（prefixStdioToolError）仍 transient
    expect(
      classifyToolError(
        "[mcp-financex/get_quote_batch] MCP stdio: 子进程在 tools/call 阶段提前退出 (exit code=1)"
      )
    ).toBe("transient");
    // jsonrpc-ndjson 断流消息
    expect(
      classifyToolError("MCP RPC: 子进程在响应 id=3 前关闭了 stdout（无任何输出）")
    ).toBe("transient");
  });

  test("中文 transient pattern 不误伤协议不兼容（拒绝了 protocolVersion 重试无意义）", () => {
    const msg =
      "MCP initialize failed: 子进程拒绝了我们支持的全部 protocolVersion (2024-11-05)。最后一次错误: unsupported protocol version";
    expect(classifyToolError(msg)).not.toBe("transient");
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

  test("P1-D：connector / builtin 常见错误归类", () => {
    expect(classifyToolError("connector_call_failed")).toBe("unknown");
    expect(classifyToolError("connector qubit-news returned errorCode=timeout")).toBe("transient");
    expect(classifyToolError("Tool \"factor.query\" is not implemented")).toBe("permanent");
    expect(classifyToolError("factor.register: project_id is required")).toBe("permanent");
    expect(classifyToolError("ETIMEDOUT during connector call")).toBe("transient");
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
