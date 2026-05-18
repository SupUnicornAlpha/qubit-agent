import { describe, expect, test } from "bun:test";
import {
  assembleAgentSystemPrompt,
  buildAgentToolsPromptBlock,
  parseToolCallFromReason,
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
