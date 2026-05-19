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
});
