import { describe, expect, test } from "bun:test";
import { parseSymbolList, resolveResearchScope } from "./research-scope";

describe("research-scope", () => {
  test("single equity long", () => {
    const s = resolveResearchScope({ ticker: "aapl" });
    expect(s.kind).toBe("single");
    expect(s.symbols).toEqual(["AAPL"]);
    expect(s.positionSide).toBe("long");
    expect(s.instrument).toBe("equity");
  });

  test("basket", () => {
    const s = resolveResearchScope({
      scope: { kind: "basket", symbols: ["AAPL", "MSFT"] },
    });
    expect(s.kind).toBe("basket");
    expect(s.symbols).toEqual(["AAPL", "MSFT"]);
  });

  test("short", () => {
    const s = resolveResearchScope({
      ticker: "TSLA",
      scope: { positionSide: "short" },
    });
    expect(s.positionSide).toBe("short");
    expect(s.displayLabel).toContain("做空");
  });

  test("parseSymbolList", () => {
    expect(parseSymbolList("aapl, msft\nnvda")).toEqual(["AAPL", "MSFT", "NVDA"]);
  });

  /**
   * P0-1 回归：explore 模式不能再产生 "AUTO_EXPLORE" 哨兵字符串。
   * 见 d0a41743 workflow 复盘 —— 哨兵被当真 ticker 一路传到 fetch_klines 红错。
   */
  describe("explore 模式不产生 AUTO_EXPLORE 哨兵", () => {
    test("纯主题、无 symbols → symbols=[]、primarySymbol=''", () => {
      const s = resolveResearchScope({
        scope: { kind: "explore", theme: "半导体 + 商业航天" },
      });
      expect(s.kind).toBe("explore");
      expect(s.symbols).toEqual([]);
      expect(s.primarySymbol).toBe("");
      expect(s.displayLabel).toBe("探索·半导体 + 商业航天·多头");
      expect(s.displayLabel).not.toContain("AUTO_EXPLORE");
      expect(s.theme).toBe("半导体 + 商业航天");
    });

    test("explore 带候选 symbols → 保留 symbols + primarySymbol 取第一个", () => {
      const s = resolveResearchScope({
        scope: { kind: "explore", theme: "AI 半导体", symbols: ["NVDA", "AMD"] },
      });
      expect(s.kind).toBe("explore");
      expect(s.symbols).toEqual(["NVDA", "AMD"]);
      expect(s.primarySymbol).toBe("NVDA");
      expect(s.displayLabel).toContain("探索");
      expect(s.displayLabel).not.toContain("AUTO_EXPLORE");
    });

    test("非 explore 模式仍然有 UNKNOWN 兜底（保持向后兼容）", () => {
      const s = resolveResearchScope({ scope: { kind: "single" } });
      expect(s.primarySymbol).toBe("UNKNOWN");
      expect(s.symbols).toEqual(["UNKNOWN"]);
    });

    test("explore 短/空 theme + 短/空 symbols 也不应该 fallback 到 AUTO_EXPLORE", () => {
      const s = resolveResearchScope({ scope: { kind: "explore" } });
      expect(s.symbols).toEqual([]);
      expect(s.primarySymbol).toBe("");
      expect(s.displayLabel).not.toContain("AUTO_EXPLORE");
    });
  });
});
