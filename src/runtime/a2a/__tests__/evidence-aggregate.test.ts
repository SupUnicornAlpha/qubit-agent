import { describe, expect, test } from "bun:test";
import { isDelegatedA2aChild } from "../evidence-aggregate";

describe("A2A evidence aggregation", () => {
  test("excludes root transport envelopes from child-gap accounting", () => {
    expect(isDelegatedA2aChild(null)).toBe(false);
    expect(isDelegatedA2aChild("   ")).toBe(false);
    expect(isDelegatedA2aChild("parent-task-1")).toBe(true);
  });
});
