import { describe, expect, test } from "bun:test";
import {
  isNarrativeNearDuplicate,
  normalizeNarrativeForCompare,
} from "./narrativeNearDuplicate";

describe("narrativeNearDuplicate", () => {
  test("exact match after markdown strip", () => {
    expect(
      isNarrativeNearDuplicate(
        "收到。目标明确：**兆易创新**",
        "收到。目标明确：兆易创新"
      )
    ).toBe(true);
  });

  test("repeated 收到 openers with same goal are duplicates", () => {
    const a =
      "收到。目标明确：兆易创新（603986.SH）、东山精密（002384.SZ）未来一周趋势研判 + 操作建议，A 股、短期窗口。";
    const b =
      "收到。目标明确：兆易创新（603986.SH）与东山精密（002384.SZ）未来一周趋势研判 + 操作建议。我先按数据先行原则推进。";
    expect(isNarrativeNearDuplicate(a, b)).toBe(true);
  });

  test("distinct progress updates are not duplicates", () => {
    expect(
      isNarrativeNearDuplicate(
        "收到。目标明确：两只标的趋势研判。",
        "## 当前状态核对\n\n- fetch_klines 已成功"
      )
    ).toBe(false);
  });

  test("normalize strips bold markers", () => {
    expect(normalizeNarrativeForCompare("**hello** world")).toBe("hello world");
  });
});
