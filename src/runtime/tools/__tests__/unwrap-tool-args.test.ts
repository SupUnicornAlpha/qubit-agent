import { describe, expect, test } from "bun:test";
import {
  coerceSymbolList,
  defaultDateWindow,
  unwrapToolArgs,
} from "../unwrap-tool-args";

describe("unwrap-tool-args", () => {
  test("flattens nested arguments with top-level win", () => {
    const out = unwrapToolArgs({
      arguments: { name: "nested", style: "low_freq" },
      name: "top",
    });
    expect(out.name).toBe("top");
    expect(out.style).toBe("low_freq");
    expect(out.arguments).toBeUndefined();
  });

  test("coerceSymbolList accepts singular ticker", () => {
    expect(coerceSymbolList({ symbol: "US:AAPL" })).toEqual(["AAPL"]);
    expect(coerceSymbolList({ symbols: ["600519.SH", "AAPL"] })).toEqual([
      "600519.SH",
      "AAPL",
    ]);
  });

  test("defaultDateWindow returns ISO dates", () => {
    const w = defaultDateWindow(30);
    expect(w.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(w.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(w.end_date >= w.start_date).toBe(true);
  });
});
