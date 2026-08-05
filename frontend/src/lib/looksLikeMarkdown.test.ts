import { describe, expect, test } from "bun:test";
import { looksLikeMarkdown } from "./looksLikeMarkdown";

describe("looksLikeMarkdown", () => {
  test("detects bold emphasis used in short orchestrator acks", () => {
    expect(
      looksLikeMarkdown(
        "收到。目标明确：**兆易创新 (603986.SH) 与 东山精密 (002384.SZ) 未来一周趋势研判 + 操作建议**。",
      ),
    ).toBe(true);
  });

  test("detects underscore bold and inline code", () => {
    expect(looksLikeMarkdown("确认数据源可用：`market_data`")).toBe(true);
    expect(looksLikeMarkdown("标的 __603986.SH__ 已锁定")).toBe(true);
  });

  test("keeps plain prose on the cheap path", () => {
    expect(looksLikeMarkdown("收到，开始调度专家。")).toBe(false);
    expect(looksLikeMarkdown("价格 * 数量 = 名义金额")).toBe(false);
  });

  test("still detects structural markdown", () => {
    expect(looksLikeMarkdown("## 结论\n- 看多")).toBe(true);
    expect(looksLikeMarkdown("见 [文档](https://example.com)")).toBe(true);
  });
});
