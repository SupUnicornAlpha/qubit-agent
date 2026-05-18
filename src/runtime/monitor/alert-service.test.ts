import { describe, expect, test } from "bun:test";
import { deriveSeverity } from "./alert-service";

describe("deriveSeverity", () => {
  test("warn for mild degradation", () => {
    expect(deriveSeverity(0.7, 0)).toBe("warn");
  });

  test("error for moderate issues", () => {
    expect(deriveSeverity(0.5, 2)).toBe("error");
  });

  test("critical for severe issues", () => {
    expect(deriveSeverity(0.2, 6)).toBe("critical");
  });
});
