import { describe, expect, test } from "bun:test";
import { buildComponentScorecards, resolveShadowVariant } from "./component-challenger-service";

describe("component challenger governance", () => {
  test("requires samples and passing evidence", () => {
    const rows = [
      { versionId: "v1", sampleSize: 10, qualityScore: 0.9, pass: true, evalKind: "offline" },
      { versionId: "v2", sampleSize: 20, qualityScore: 0.8, pass: true, evalKind: "shadow" },
    ] as never;
    const cards = buildComponentScorecards(rows, 20);
    expect(cards.find((card) => card.versionId === "v1")?.eligible).toBe(false);
    expect(cards.find((card) => card.versionId === "v2")?.eligible).toBe(true);
  });

  test("never routes live traffic to challenger", () => {
    expect(resolveShadowVariant({ allocationKey: "run-1", challengerTrafficPct: 1, executionMode: "live" })).toBe("control");
    expect(["control", "challenger"]).toContain(resolveShadowVariant({ allocationKey: "run-2", challengerTrafficPct: 0.1, executionMode: "paper" }));
  });
});
