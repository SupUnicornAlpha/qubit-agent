/**
 * 2026-05-27 P0-1 修复回归测试：
 *
 * 背景：WF a09e90c5 / 9adf5d91 实测，4 个 analyst 全部 `signal_parse_failed`
 * 但分析师其实正常输出了 ```json 信号块。根因是旧 `parseJsonSignalFromText`
 * 用 `/\{[\s\S]*\}/` 贪婪匹配，跨越围栏 / markdown / `<TOOL_CALL>` 多段。
 *
 * 本测试针对 `extractSignalJsonFromText` 验证：
 *   1. 围栏 ```json {...} ``` 能被抽出来
 *   2. 围栏后追加 `<TOOL_CALL>{...}` 不会干扰
 *   3. 没 signal 字段的 JSON 不会被错选
 *   4. 多个 JSON 候选，优先返回含 signal 字段那个
 *   5. 完全无 JSON 时返回 null
 *   6. 嵌套对象（valuation_anchor / quant_anchor）不会破坏 brace 匹配
 */

import { describe, expect, it } from "bun:test";
import { extractSignalJsonFromText } from "../analyst-team-slot-react";

describe("extractSignalJsonFromText", () => {
  it("returns null on empty / null-ish input", () => {
    expect(extractSignalJsonFromText("")).toBeNull();
    expect(extractSignalJsonFromText("   \n\t  ")).toBeNull();
    expect(extractSignalJsonFromText("纯 markdown 没有任何 JSON 内容")).toBeNull();
  });

  it("extracts JSON from a fenced ```json block (technical analyst typical output)", () => {
    const text = [
      "## 技术分析信号（RKLB — 日线，2026-05-26 收盘）",
      "",
      "### 1. 趋势与动量结构",
      "- 强多头趋势...",
      "",
      "```json",
      "{",
      '  "signal": "hold",',
      '  "confidence": 0.55,',
      '  "reasoning": "[趋势] 强多头趋势，MACD 扩张...",',
      '  "entry_zone": "建议回踩 115-120 区域",',
      '  "stop_loss": "127.3",',
      '  "regime": "breakout_consolidation",',
      '  "quant_anchor": {"factor_id": null, "rank_ic": null, "ir": null, "sample_size": null}',
      "}",
      "```",
      "",
      "**回测/样本外验证建议**：可在 SMA20 偏离度 > 30% 且 RSI > 70 时...",
    ].join("\n");
    const obj = extractSignalJsonFromText(text);
    expect(obj).not.toBeNull();
    expect(obj?.signal).toBe("hold");
    expect(obj?.confidence).toBe(0.55);
    expect(obj?.regime).toBe("breakout_consolidation");
  });

  it("ignores trailing <TOOL_CALL>{...} block and still finds signal JSON", () => {
    const text = [
      "## 基本面分析",
      "...",
      "```json",
      "{",
      '  "signal": "hold",',
      '  "confidence": 0.4,',
      '  "reasoning": "财报数据缺失",',
      '  "valuation_anchor": {"pe": 0, "pb": 0, "industry_pct": 0, "note": "..."}',
      "}",
      "```",
      "",
      "<TOOL_CALL>",
      '{"tool":"none","summary":"无可用工具获取额外基本面数据"}',
      "</TOOL_CALL>",
    ].join("\n");
    const obj = extractSignalJsonFromText(text);
    expect(obj).not.toBeNull();
    expect(obj?.signal).toBe("hold");
    expect(obj?.confidence).toBe(0.4);
    expect((obj as { tool?: unknown })?.tool).toBeUndefined();
  });

  it("returns the signal JSON even when only TOOL_CALL JSON exists (no signal-bearing JSON)", () => {
    const text = [
      "我先调用工具拉取数据。",
      "",
      "<TOOL_CALL>",
      '{"tool":"call_mcp","params":{"serverName":"mcp-financex","mcpTool":"x"}}',
      "</TOOL_CALL>",
    ].join("\n");
    expect(extractSignalJsonFromText(text)).toBeNull();
  });

  it("handles inline JSON without code fences (degraded but legal)", () => {
    const text =
      '基本面分析完成。{"signal": "buy", "confidence": 0.72, "reasoning": "Q3 营收同比 +35%，EPS 转正"}';
    const obj = extractSignalJsonFromText(text);
    expect(obj).not.toBeNull();
    expect(obj?.signal).toBe("buy");
    expect(obj?.confidence).toBe(0.72);
  });

  it("when there are multiple candidates, picks the one containing signal field", () => {
    const text = [
      "首先列一些数据：",
      '```json',
      '{"market_data": {"price": 119.7, "volume": 2300000}}',
      '```',
      "然后是信号：",
      "```json",
      '{"signal": "sell", "confidence": 0.6, "reasoning": "RSI 顶背离"}',
      "```",
    ].join("\n");
    const obj = extractSignalJsonFromText(text);
    expect(obj).not.toBeNull();
    expect(obj?.signal).toBe("sell");
  });

  it("handles strings containing curly braces (e.g. reasoning with sets/objects)", () => {
    const text = [
      "```json",
      "{",
      '  "signal": "buy",',
      '  "confidence": 0.65,',
      '  "reasoning": "看到 {bullish, oversold} 双重信号，stop_loss <= entry_zone * 0.95"',
      "}",
      "```",
    ].join("\n");
    const obj = extractSignalJsonFromText(text);
    expect(obj).not.toBeNull();
    expect(obj?.signal).toBe("buy");
    expect(obj?.confidence).toBe(0.65);
  });

  it("rejects malformed JSON candidates (truncated braces)", () => {
    const text = [
      "```json",
      "{",
      '  "signal": "buy",',
      '  "confidence": 0.5',
      // missing closing brace
      "```",
    ].join("\n");
    expect(extractSignalJsonFromText(text)).toBeNull();
  });

  it("WF 9adf5d91 / a09e90c5 实测的 fundamental 文本可以解析", () => {
    // 来自 WF a09e90c5 def-analyst-fundamental 的实际尾段(略简化)
    const text = `好的，我是基本面分析师。

## Step 1: 盈利质量分析

**数据现状**：fetch_fundamentals 返回空 periods。

\`\`\`json
{
  "signal": "hold",
  "confidence": 0.4,
  "reasoning": "RKLB 在 Neutron 火箭和 $90M Space Force 合同上有催化剂",
  "key_drivers": [
    "$90M Space Force GEO 合同",
    "垂直整合模式"
  ],
  "key_risks": [
    "股价 20 日 +74%，RSI 71.33 超买",
    "无财务数据验证"
  ],
  "valuation_anchor": {"pe": 0, "pb": 0, "industry_pct": 0, "note": "财报数据缺失"},
  "quant_anchor": {"factor_id": "", "rank_ic": 0, "sample_size": 0}
}
\`\`\`

<TOOL_CALL>
{"tool":"none","summary":"无可用工具获取额外基本面数据"}
</TOOL_CALL>`;
    const obj = extractSignalJsonFromText(text);
    expect(obj).not.toBeNull();
    expect(obj?.signal).toBe("hold");
    expect(obj?.confidence).toBe(0.4);
    expect(Array.isArray((obj as { key_drivers?: unknown[] }).key_drivers)).toBe(true);
  });
});
