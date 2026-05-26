/**
 * `extractHitlHintFromText` 回归测试：对话 orchestrator 的 reasonText 经常会拼上
 * `<TOOL_CALL>...</TOOL_CALL>`，hitlHint 解析必须只看尾部分隔符，不被工具块干扰。
 *
 * 这是"对话窗口 HITL 选择题"链路的关键中间环节——如果这个 parser 误判，hitl-gate
 * 就拿不到 inputKind/options，对话 HITL 还会退回 approve_only。
 */
import { describe, expect, test } from "bun:test";
import { extractHitlHintFromText, HITL_HINT_DELIMITER } from "../hitl-hint-parse";

const REASON_WITH_TOOL_CALL = (hintJson: string) =>
  [
    "我需要先拉个行情快照确认走势再做决定。",
    "",
    "<TOOL_CALL>",
    '{"tool":"fetch_klines","params":{"symbol":"AAPL"}}',
    "</TOOL_CALL>",
    "",
    HITL_HINT_DELIMITER,
    hintJson,
  ].join("\n");

describe("extractHitlHintFromText", () => {
  test("普通工具调用 + 无 hitlHint → 返回 null", () => {
    const text = [
      "我先拉个数据",
      "<TOOL_CALL>",
      '{"tool":"fetch_klines","params":{}}',
      "</TOOL_CALL>",
    ].join("\n");
    expect(extractHitlHintFromText(text)).toBeNull();
  });

  test("尾部带 single_choice hitlHint → 正确解析", () => {
    const hint = extractHitlHintFromText(
      REASON_WITH_TOOL_CALL(
        JSON.stringify({
          needed: true,
          reason: "存在两条路径",
          inputKind: "single_choice",
          options: [
            { label: "走 A", value: "a" },
            { label: "走 B", value: "b", description: "更激进" },
          ],
        })
      )
    );
    expect(hint).not.toBeNull();
    expect(hint?.needed).toBe(true);
    expect(hint?.inputKind).toBe("single_choice");
    expect(hint?.options).toHaveLength(2);
    expect(hint?.options?.[1]?.description).toBe("更激进");
  });

  test("free_form 形态（无 options） → options 字段为 undefined", () => {
    const hint = extractHitlHintFromText(
      REASON_WITH_TOOL_CALL(
        JSON.stringify({ needed: true, reason: "需要一句指引", inputKind: "free_form" })
      )
    );
    expect(hint?.inputKind).toBe("free_form");
    expect(hint?.options).toBeUndefined();
  });

  test("hitlHint JSON 无效 → null（不污染主流程）", () => {
    const hint = extractHitlHintFromText(
      `推理\n${HITL_HINT_DELIMITER}\n{invalid json :)`
    );
    expect(hint).toBeNull();
  });

  test("空 / null 输入 → null", () => {
    expect(extractHitlHintFromText("")).toBeNull();
    expect(extractHitlHintFromText(null)).toBeNull();
    expect(extractHitlHintFromText(undefined)).toBeNull();
  });
});
