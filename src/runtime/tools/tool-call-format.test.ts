/**
 * tool-call-format 导入链会触发 connectors/bootstrap → drizzle migrate 写盘。
 * 在本地开发时如果生产 sqlite 被 backend 持锁，bootstrap 会 SQLITE_READONLY 直挂。
 * 用 tmpdir 兜底让单测脱离任何外部 DB 影响（CI 上也确定性）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = join(tmpdir(), `qubit-tool-call-format-${process.pid}-${Date.now()}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(join(tmpDir, "db"), { recursive: true });
process.env.QUBIT_DATA_DIR = tmpDir;
process.env.HOME = tmpDir;

const { describe, expect, test } = await import("bun:test");
const {
  assembleAgentSystemPrompt,
  buildAgentToolsPromptBlock,
  parseToolCallFromReason,
  stripToolCallSentinels,
} = await import("./tool-call-format");

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

  test("Step 3：deprecated 别名只要 replacedBy 在订阅里就放行（兼容旧 prompt）", () => {
    // 订阅里只有 fetch_klines（新名字），LLM 调老名字 fetch_bars 也应该通过 parse
    const r = parseToolCallFromReason(
      '```json\n{"tool":"fetch_bars","params":{"symbol":"600519"}}\n```',
      ["fetch_klines"]
    );
    expect(r.kind).toBe("tool");
    if (r.kind === "tool") {
      // parse 阶段保留原名 — act 节点会做透明 resolve 到 fetch_klines
      expect(r.toolName).toBe("fetch_bars");
    }
  });

  test("Step 3：replacedBy 不在订阅里时，deprecated 别名仍被拒（安全）", () => {
    // 订阅里没有 fetch_klines，调 fetch_bars 应该被拒
    const r = parseToolCallFromReason(
      '```json\n{"tool":"fetch_bars","params":{}}\n```',
      ["run_analyst_team"]
    );
    expect(r.kind).toBe("parse_error");
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

  /**
   * E1 回归：mcp_server_config.capabilities_json.tools 注入的真实工具清单
   * 必须在 prompt 里完整列出，让 LLM 不再瞎喊不存在的工具名
   * （如把 mcp-financex 的 get_financial_statements 喊成 get_financials）。
   */
  test("注入 MCP server 的真实工具清单", () => {
    const block = buildAgentToolsPromptBlock({
      tools: [],
      mcpServers: [
        {
          name: "mcp-financex",
          tools: [
            { name: "get_quote", desc: "实时行情" },
            { name: "get_financial_statements", desc: "财报三表" },
          ],
        },
      ],
    });
    expect(block).toContain("mcp-financex");
    expect(block).toContain("真实工具清单");
    expect(block).toContain("`get_quote`");
    expect(block).toContain("`get_financial_statements`");
    expect(block).toContain("实时行情");
    expect(block).toContain("财报三表");
  });

  test("string 形态 mcpServers 仍可用（向后兼容）", () => {
    const block = buildAgentToolsPromptBlock({
      tools: [],
      mcpServers: ["mathjs", "tradingcalc"],
    });
    expect(block).toContain("mathjs");
    expect(block).toContain("tradingcalc");
    /** 没有 tools 字段时不应该出现"真实工具清单"标题 */
    expect(block).not.toContain("真实工具清单");
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

  /**
   * F-P0-04 回归（2026-06 评估批次）：研究/回测 aux slot 的 LLM 输出会被直接
   * 拼进最终报告。typical pattern 是 LLM 写完研究 markdown 之后再 emit 一个
   * tool_call=none 的 sentinel "宣告任务完成"——这个 sentinel 之前没被
   * analyst-team-slot-react.ts 剥掉，导致用户看到的报告结尾出现 raw JSON。
   *
   * 修复点：slot-react.ts 在返回 markdown body 时调 stripToolCallSentinels。
   * 本组 case 锁死 strip helper 能正确处理 aux slot 真实输出形态。
   */
  describe("F-P0-04：aux slot 真实输出形态", () => {
    test("研究报告 + 末尾 tool_call=none sentinel → 仅保留 markdown 报告", () => {
      const text = [
        "## NVDA 策略撰写",
        "",
        "- **核心假设**：AI infra 需求扩张推动 H100 / GB200 出货拉动 1Q26 营收。",
        "- **入场条件**：站稳 850 + 周线 MACD 金叉。",
        "- **风险**：估值消化期回踩 720。",
        "",
        "<TOOL_CALL>",
        '{"tool":"none","summary":"研究报告已完成，无需继续调工具"}',
        "</TOOL_CALL>",
      ].join("\n");
      const out = stripToolCallSentinels(text);
      expect(out).not.toContain("TOOL_CALL");
      expect(out).not.toContain("tool");
      expect(out).toContain("## NVDA 策略撰写");
      expect(out).toContain("AI infra");
    });

    test("回测方案 markdown + 末尾 fenced JSON tool_call → 仅保留方案", () => {
      const text = [
        "## 回测方案（SMA(20,60) crossover）",
        "",
        "数据窗：2020-01-01 ~ 2026-05-31，月度再平衡。",
        "评价：年化收益 / 最大回撤 / Sharpe。",
        "",
        "```json",
        '{"tool":"backtest.run","params":{"strategy_id":"sma-20-60","symbol":"NVDA"}}',
        "```",
      ].join("\n");
      const out = stripToolCallSentinels(text);
      expect(out).not.toContain('"tool"');
      expect(out).toContain("## 回测方案");
      expect(out).toContain("年化收益");
    });

    test("max_iterations 命中：LLM 仍想调工具，留下未闭合 sentinel → 剥干净", () => {
      const text = [
        "已采集 NVDA 近 60 日 K 线 + PE/PB 分位。",
        "拟下一步：让 sentiment 角色补 social heat 数据。",
        "",
        "<TOOL_CALL>",
        '{"tool":"fetch_news_sentiment","params":{"sym',
      ].join("\n");
      const out = stripToolCallSentinels(text);
      expect(out).not.toContain("TOOL_CALL");
      expect(out).not.toContain("fetch_news_sentiment");
      expect(out).toContain("已采集 NVDA");
    });

    test("研究中段穿插 tool sentinel（不应误剥 markdown 内容） + 末尾 sentinel", () => {
      const text = [
        "## 因子候选",
        "1. 动量 12-1（剔除最近 1 月）",
        "2. 质量 ROIC",
        "",
        "<TOOL_CALL>",
        '{"tool":"factor.list","params":{}}',
        "</TOOL_CALL>",
        "",
        "3. 价值 EV/EBITDA",
        "",
        "<TOOL_CALL>",
        '{"tool":"none","summary":"候选清单已成型"}',
        "</TOOL_CALL>",
      ].join("\n");
      const out = stripToolCallSentinels(text);
      expect(out).not.toContain("TOOL_CALL");
      expect(out).not.toContain('"tool"');
      expect(out).toContain("动量 12-1");
      expect(out).toContain("质量 ROIC");
      expect(out).toContain("价值 EV/EBITDA");
    });
  });
});
