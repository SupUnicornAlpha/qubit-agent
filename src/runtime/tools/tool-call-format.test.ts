import { describe, expect, test } from "bun:test";
import {
  assembleAgentSystemPrompt,
  buildAgentToolsPromptBlock,
  parseToolCallFromReason,
  stripToolCallSentinels,
} from "./tool-call-format";

describe("parseToolCallFromReason", () => {
  const tools = ["fetch_klines", "run_analyst_team", "call_mcp"];

  test("parses fenced JSON tool call", () => {
    const r = parseToolCallFromReason(
      `分析如下。\n\`\`\`json\n{"tool":"fetch_klines","params":{"symbol":"600519","limit":60}}\n\`\`\``,
      tools
    );
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      expect(r.toolName).toBe("fetch_klines");
      expect(r.params["symbol"]).toBe("600519");
    }
  });

  test("parses tool none", () => {
    const r = parseToolCallFromReason('结论如下。\n```json\n{"tool":"none","summary":"无需工具"}\n```', tools);
    expect(r.kind).toBe("none");
  });

  test("rejects missing JSON block", () => {
    const r = parseToolCallFromReason("只有文字，没有工具 JSON", tools);
    expect(r.kind).toBe("parse_error");
  });

  test("rejects tool not in allowlist", () => {
    const r = parseToolCallFromReason('```json\n{"tool":"submit_order","params":{}}\n```', tools);
    expect(r.kind).toBe("parse_error");
  });

  test("does not fallback to first tool", () => {
    const r = parseToolCallFromReason("提及 fetch_klines 但未给 JSON", tools);
    expect(r.kind).toBe("parse_error");
  });

  test("优先匹配 <TOOL_CALL> sentinel（即便前面有示例 fenced JSON 也不被误抓）", () => {
    const r = parseToolCallFromReason(
      [
        "我先想一下…例如可以这样调用：",
        "```json",
        '{"tool":"fetch_klines","params":{"symbol":"OLD"}}',
        "```",
        "实际本轮决定：",
        "<TOOL_CALL>",
        '{"tool":"fetch_klines","params":{"symbol":"NEW","limit":30}}',
        "</TOOL_CALL>",
      ].join("\n"),
      tools
    );
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      expect(r.toolName).toBe("fetch_klines");
      expect(r.params["symbol"]).toBe("NEW");
    }
  });

  test("sentinel 内 tool=none 也能解析", () => {
    const r = parseToolCallFromReason(
      "结论清楚，不需要工具。\n<TOOL_CALL>\n{\"tool\":\"none\",\"summary\":\"已答\"}\n</TOOL_CALL>",
      tools
    );
    expect(r.kind).toBe("none");
  });

  test("多个 fenced JSON 时取最后一个含 tool 字段的（修复示例 JSON 优先级 bug）", () => {
    const r = parseToolCallFromReason(
      [
        "可以参考这个示例：",
        "```json",
        '{"explanation":"only示例","x":1}',
        "```",
        "我决定调用：",
        "```json",
        '{"tool":"fetch_klines","params":{"symbol":"600519"}}',
        "```",
      ].join("\n"),
      tools
    );
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      expect(r.toolName).toBe("fetch_klines");
      expect(r.params["symbol"]).toBe("600519");
    }
  });

  test("parses call_mcp", () => {
    const r = parseToolCallFromReason(
      '```json\n{"tool":"call_mcp","params":{"serverName":"mathjs","mcpTool":"add","arguments":{"a":1,"b":2}}}\n```',
      tools
    );
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      expect(r.mcp?.serverName).toBe("mathjs");
      expect(r.mcp?.toolName).toBe("add");
    }
  });
});

describe("buildAgentToolsPromptBlock", () => {
  test("includes tool names and call_mcp hint", () => {
    const block = buildAgentToolsPromptBlock({
      tools: ["fetch_klines"],
      mcpServers: ["mathjs"],
    });
    expect(block).toContain("fetch_klines");
    expect(block).toContain("call_mcp");
    expect(block).toContain("mathjs");
  });

  test("提示中包含 <TOOL_CALL> sentinel 首选格式", () => {
    const block = buildAgentToolsPromptBlock({ tools: ["fetch_klines"] });
    expect(block).toContain("<TOOL_CALL>");
    expect(block).toContain("</TOOL_CALL>");
  });
});

describe("assembleAgentSystemPrompt", () => {
  test("appends tools block after base prompt", () => {
    const { full, toolsBlock } = assembleAgentSystemPrompt("你是研究员。", {
      tools: ["fetch_klines"],
      mcpServers: [],
    });
    expect(toolsBlock).toContain("fetch_klines");
    expect(full).toBe(`你是研究员。\n\n${toolsBlock}`);
  });

  test("returns base only when no tools", () => {
    const { full, toolsBlock } = assembleAgentSystemPrompt("仅正文。", { tools: [], mcpServers: [] });
    expect(toolsBlock).toBe("");
    expect(full).toBe("仅正文。");
  });
});

describe("stripToolCallSentinels", () => {
  test("剥掉单个 sentinel 块，保留正文", () => {
    const text =
      "你好！我是 Orchestrator。\n<TOOL_CALL>\n{\"tool\":\"none\",\"summary\":\"用户只是打招呼\"}\n</TOOL_CALL>";
    expect(stripToolCallSentinels(text)).toBe("你好！我是 Orchestrator。");
  });

  test("剥掉多个 sentinel 块（避免循环累积）", () => {
    const text = [
      "你好！👋",
      "<TOOL_CALL>{\"tool\":\"none\",\"summary\":\"hi\"}</TOOL_CALL>",
      "我还在等任务。",
      "<TOOL_CALL>{\"tool\":\"none\",\"summary\":\"again\"}</TOOL_CALL>",
    ].join("\n");
    expect(stripToolCallSentinels(text)).toBe("你好！👋\n我还在等任务。");
  });

  test("剥掉未闭合的尾部 sentinel（流式输出半截）", () => {
    const text = "分析结论：估值合理。\n<TOOL_CALL>\n{\"tool\":\"non";
    expect(stripToolCallSentinels(text)).toBe("分析结论：估值合理。");
  });

  test("剥掉 fenced JSON tool 块", () => {
    const text =
      "分析中。\n```json\n{\"tool\":\"fetch_klines\",\"params\":{\"symbol\":\"AAPL\"}}\n```\n继续。";
    const out = stripToolCallSentinels(text);
    expect(out).not.toContain("fetch_klines");
    expect(out).toContain("分析中");
    expect(out).toContain("继续。");
  });

  test("空/null 输入返回空字符串", () => {
    expect(stripToolCallSentinels(null)).toBe("");
    expect(stripToolCallSentinels(undefined)).toBe("");
    expect(stripToolCallSentinels("")).toBe("");
  });

  test("无 sentinel 时只做空行压缩", () => {
    const text = "段落 1\n\n\n\n段落 2";
    expect(stripToolCallSentinels(text)).toBe("段落 1\n\n段落 2");
  });
});
