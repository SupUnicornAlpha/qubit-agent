import { describe, expect, test } from "bun:test";
import { isBenchmarkNamespace } from "./benchmark-namespace";

describe("benchmark namespace", () => {
  test("is opt-in and survives loop-options parsing", () => {
    expect(isBenchmarkNamespace({ benchmarkNamespace: true })).toBe(true);
    expect(isBenchmarkNamespace({ benchmarkNamespace: false })).toBe(false);
    expect(isBenchmarkNamespace({})).toBe(false);
  });
});
