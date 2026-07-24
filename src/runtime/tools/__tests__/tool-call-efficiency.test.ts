import { describe, expect, test } from "bun:test";
import {
  buildNativeQubitToolDefinition,
  nativeToolCallToSentinel,
  selectRelevantToolsForPrompt,
} from "../tool-call-format";

describe("tool prompt efficiency", () => {
  test("大量工具按目标筛到上限并保留编排工具", () => {
    const tools = [
      "assign_task",
      "update_plan",
      "fetch_klines",
      "fetch_news",
      "backtest.run",
      "factor.list",
      "factor.compute",
      "submit_order",
      "evaluate_risk",
    ];
    const selected = selectRelevantToolsForPrompt(tools, "研究动量因子并进行回测", 5);
    expect(selected).toContain("assign_task");
    expect(selected).toContain("update_plan");
    expect(selected).toContain("backtest.run");
    expect(selected.length).toBe(5);
  });

  test("编排工具数量超过软上限时仍全部保留", () => {
    const selected = selectRelevantToolsForPrompt(
      ["assign_task", "update_plan", "call_mcp", "call_team_risk", "fetch_klines"],
      "查询行情",
      2
    );
    expect(selected).toEqual(["assign_task", "update_plan", "call_mcp", "call_team_risk"]);
  });

  test("原生工具定义使用单一 qubit_action 和 enum", () => {
    const definition = buildNativeQubitToolDefinition(["fetch_klines", "factor.list"]);
    expect(definition?.name).toBe("qubit_action");
    const properties = definition?.parameters.properties as Record<string, unknown>;
    const tool = properties.tool as Record<string, unknown>;
    expect(tool.enum).toEqual(["fetch_klines", "factor.list"]);
  });

  test("原生调用转换为兼容 sentinel", () => {
    const text = nativeToolCallToSentinel(
      {
        id: "call-1",
        name: "qubit_action",
        args: { tool: "fetch_klines", params: { symbol: "AAPL" } },
      },
      ["fetch_klines"]
    );
    expect(text).toContain("<TOOL_CALL>");
    expect(text).toContain('"tool":"fetch_klines"');
  });
});
