import { describe, expect, test } from "bun:test";
import { extractFinalizeAnswerText } from "./run-react-loop";

describe("extractFinalizeAnswerText", () => {
  test("工具调用耗尽迭代时保留正文并剥离 tool sentinel", () => {
    const text = [
      "## 最后一版分析",
      "",
      "市场风险主要来自财报与地缘事件。",
      "",
      "<TOOL_CALL>",
      '{"tool":"market.news","params":{"symbol":"SPY"}}',
      "</TOOL_CALL>",
    ].join("\n");

    expect(extractFinalizeAnswerText({ reasonText: text, observations: [] })).toBe(
      "## 最后一版分析\n\n市场风险主要来自财报与地缘事件。"
    );
  });

  test("reason 只有工具内容时回退最近 observation 的分析正文", () => {
    expect(
      extractFinalizeAnswerText({
        reasonText: '<TOOL_CALL>{"tool":"market.news","params":{}}</TOOL_CALL>',
        observations: [{ reasonText: "较早分析" }, { reasonText: "最近一版可用分析" }],
      })
    ).toBe("最近一版可用分析");
  });
});
