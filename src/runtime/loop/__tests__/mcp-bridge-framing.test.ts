import { describe, expect, test } from "bun:test";
import { takeMcpMessages } from "../mcp-bridge-server";

describe("takeMcpMessages — newline-delimited (Claude Code / Codex / MCP spec)", () => {
  test("解析多条完整行，保留未结束的尾行", () => {
    const state = { contentLength: false };
    const buf = Buffer.from(
      `{"jsonrpc":"2.0","id":0,"method":"initialize"}\n{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n{"partial":`,
      "utf8"
    );
    const { msgs, rest } = takeMcpMessages(buf, state);
    expect(msgs.length).toBe(2);
    expect(msgs[0]?.method).toBe("initialize");
    expect(msgs[1]?.method).toBe("tools/list");
    expect(state.contentLength).toBe(false);
    expect(rest.toString("utf8")).toBe('{"partial":');
  });

  test("跳过非 JSON 噪声行，继续解析后续合法行", () => {
    const state = { contentLength: false };
    const buf = Buffer.from(`oops not json\n{"jsonrpc":"2.0","id":2}\n`, "utf8");
    const { msgs } = takeMcpMessages(buf, state);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.id).toBe(2);
  });

  test("前导空白/换行被跳过", () => {
    const state = { contentLength: false };
    const { msgs } = takeMcpMessages(Buffer.from(`\n\n  {"id":9}\n`, "utf8"), state);
    expect(msgs[0]?.id).toBe(9);
  });

  test("UTF-8（中文）行正确解析", () => {
    const state = { contentLength: false };
    const { msgs } = takeMcpMessages(
      Buffer.from(`{"method":"tools/call","params":{"q":"分析英伟达"}}\n`, "utf8"),
      state
    );
    expect((msgs[0]?.params as { q: string }).q).toBe("分析英伟达");
  });
});

describe("takeMcpMessages — Content-Length 帧（兼容旧客户端）", () => {
  test("识别并解析 LSP 帧，置 contentLength=true", () => {
    const state = { contentLength: false };
    const body = '{"jsonrpc":"2.0","id":0,"method":"initialize"}';
    const len = Buffer.byteLength(body, "utf8");
    const buf = Buffer.from(`Content-Length: ${len}\r\n\r\n${body}`, "utf8");
    const { msgs, rest } = takeMcpMessages(buf, state);
    expect(msgs.length).toBe(1);
    expect(msgs[0]?.method).toBe("initialize");
    expect(state.contentLength).toBe(true);
    expect(rest.length).toBe(0);
  });

  test("body 未到齐时等待（不消费）", () => {
    const state = { contentLength: false };
    const buf = Buffer.from(`Content-Length: 100\r\n\r\n{"partial":true}`, "utf8");
    const { msgs, rest } = takeMcpMessages(buf, state);
    expect(msgs.length).toBe(0);
    expect(rest.length).toBeGreaterThan(0);
  });
});
