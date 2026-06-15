import { describe, expect, test } from "bun:test";
import { _formatStdioExitErrorMessage, prefixStdioToolError } from "../stdio-session";
import { classifyToolError } from "../../langgraph/nodes/tool-error-classifier";

/*
 * F-P0-07 regression：之前 stderrBuf 用 `.slice(-1200)` 按字节截断，eval batch 2
 * 的 mcp-financex 子进程 crash 时 `…/financials.js:175:28` 这一行被砍掉首字符变成
 * `inancials.js:175:28`，让排查者怀疑 backend 路径被吃掉。这里钉死新行为：按行
 * 取最后 20 行，每行最多 240 字符。
 */
describe("_formatStdioExitErrorMessage (F-P0-07)", () => {
  test("空 stderr → 只输出 header（不带尾随空 stderr 块）", () => {
    const msg = _formatStdioExitErrorMessage([], 1, "tools/call");
    expect(msg).toBe("MCP stdio: 子进程在 tools/call 阶段提前退出 (exit code=1)");
  });

  test("exit code 缺失（subprocess 已被 SIGKILL 之类）→ '?'", () => {
    const msg = _formatStdioExitErrorMessage(["oops\n"], null, "initialize");
    expect(msg).toContain("(exit code=?)");
    expect(msg).toContain("oops");
  });

  test("按行截断保留完整 stack-frame —— 不再把 financials.js 砍成 inancials.js", () => {
    const stderrChunks: string[] = [];
    // 模拟 mcp-financex crash 的真实 console.error pattern
    for (let i = 0; i < 100; i++) {
      stderrChunks.push(`[debug] yahoo response chunk ${i} bytes=${1024 + i}\n`);
    }
    stderrChunks.push(
      "TypeError: Cannot read properties of undefined (reading 'symbol')\n" +
        "    at parseQuote (/Users/me/.quant-agent/mcp-bin/node_modules/mcp-financex/dist/financials.js:175:28)\n" +
        "    at async getFinancialStatements (/Users/me/.quant-agent/mcp-bin/node_modules/mcp-financex/dist/financials.js:201:5)\n"
    );

    const msg = _formatStdioExitErrorMessage(stderrChunks, 1, "tools/call");

    // 新行为：完整文件名出现
    expect(msg).toContain("financials.js:175:28");
    expect(msg).toContain("financials.js:201:5");
    // 旧行为不再出现：不应被砍成 'inancials.js'
    expect(msg).not.toMatch(/[^f]inancials\.js/);
  });

  test("单行超长被截断到 240 字符 + 省略号（避免单条 JSON dump 把 errMsg 撑爆 stack）", () => {
    const longLine = "X".repeat(1000) + "tail-marker";
    const msg = _formatStdioExitErrorMessage([longLine + "\n"], 1, "tools/call");
    // 截断标记
    expect(msg).toContain("…");
    // 整行 X 的总长度不会超过 240+省略号
    expect(msg).not.toContain("tail-marker");
    const xRun = msg.match(/X+/);
    expect(xRun?.[0]?.length ?? 0).toBeLessThanOrEqual(240);
  });

  test("仅保留最后 20 行（早于此的 noisy log 被丢弃）", () => {
    const chunks: string[] = [];
    for (let i = 0; i < 50; i++) chunks.push(`line-${i}\n`);
    const msg = _formatStdioExitErrorMessage(chunks, 1, "initialize");
    // 最后一行必出现
    expect(msg).toContain("line-49");
    expect(msg).toContain("line-30");
    // 前 30 行不再出现
    expect(msg).not.toContain("line-29");
    expect(msg).not.toContain("line-0");
  });

  test("phase 字符串原样嵌入 header", () => {
    expect(_formatStdioExitErrorMessage([], 0, "tools/call")).toContain(
      "在 tools/call 阶段"
    );
    expect(_formatStdioExitErrorMessage([], 0, "initialize")).toContain("在 initialize 阶段");
  });
});

describe("prefixStdioToolError", () => {
  test("给裸错误消息加 [server/tool] 前缀", () => {
    const out = prefixStdioToolError(
      "mcp-financex",
      "compare_peer_companies",
      "At least 2 symbols are required for comparison."
    );
    expect(out).toBe(
      "[mcp-financex/compare_peer_companies] At least 2 symbols are required for comparison."
    );
  });

  test("已带前缀时不重复叠加（幂等）", () => {
    const once = prefixStdioToolError("s", "t", "boom");
    const twice = prefixStdioToolError("s", "t", once);
    expect(twice).toBe(once);
    expect(twice.match(/\[s\/t\]/g)?.length).toBe(1);
  });

  test("前缀不污染 errorClass 分类（compare_peer_companies 缺参 → 仍非 blocked/transient 误判）", () => {
    // 关键回归：加前缀后分类结果应与裸消息一致，不能因为前缀里的字符触发 BLOCKED/TRANSIENT 正则
    const raw = "At least 2 symbols are required for comparison.";
    const prefixed = prefixStdioToolError("mcp-financex", "compare_peer_companies", raw);
    expect(classifyToolError(prefixed)).toBe(classifyToolError(raw));
  });

  test("子进程退出类错误加前缀后分类结果不变（无论原类别）", () => {
    const raw = "MCP stdio: 子进程在 tools/call 阶段提前退出 (exit code=1)";
    const prefixed = prefixStdioToolError("mcp-financex", "get_quote_batch", raw);
    // 核心保证：加前缀不能改变 classifyToolError 的判定结果
    expect(classifyToolError(prefixed)).toBe(classifyToolError(raw));
  });

  test("含 timeout 关键词的错误加前缀后仍被分类为 transient", () => {
    const raw = "request timed out after 60000ms";
    const prefixed = prefixStdioToolError("mcp-financex", "get_quote", raw);
    expect(classifyToolError(raw)).toBe("transient");
    expect(classifyToolError(prefixed)).toBe("transient");
  });
});
