import { describe, expect, test } from "bun:test";
import {
  mapDispatchResultsToWaveResults,
  slotReactOutToSlotResult,
} from "../team-slot-executor";
import type { SlotDispatchResult } from "../team-slot-a2a";

describe("team-slot-executor (batch 2)", () => {
  test("slotReactOutToSlotResult analyst", () => {
    const r = slotReactOutToSlotResult({
      kind: "analyst",
      payload: {
        role: "analyst_technical",
        signal: "buy",
        confidence: 0.7,
        reasoning: "ok",
        structured: {},
      },
    });
    expect(r.kind).toBe("analyst");
  });

  test("mapDispatchResultsToWaveResults 顺序对齐", () => {
    const specs = [{ instanceId: "a" }, { instanceId: "b" }];
    const map = new Map<string, SlotDispatchResult>([
      ["a", { ok: true, reactOut: { kind: "markdown", body: "x" } }],
      ["b", { ok: false, error: "fail" }],
    ]);
    const results = mapDispatchResultsToWaveResults(specs, map);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]?.status).toBe("rejected");
  });
});
