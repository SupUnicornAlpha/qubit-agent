import { describe, expect, test } from "bun:test";
import { looksLikeStubNarrative, scoreSoftDimensions } from "../soft-dimensions";
import type { RunEnvelope } from "../contracts";

function base(): RunEnvelope {
  return {
    workflowRunId: "soft-unit",
    suite: "L0",
    scenarioKey: "research",
    harnessVersion: "qubit-bench-v0.2",
    terminal: { status: "completed" },
    tools: [{ name: "get_quote", status: "success", requestFingerprint: "a" }],
    artifacts: [],
    artifactGate: { available: true, ok: true, missing: [] },
    delivery: { observed: true, hasUserFinalAnswer: true },
    deliveryVerdict: { available: true, state: "delivered", reasonCodes: [] },
  };
}

describe("soft-dimensions", () => {
  test("detects invoke stub narratives", () => {
    expect(looksLikeStubNarrative("invoke completed: compare NVDA vs AMD")).toBe(true);
    expect(looksLikeStubNarrative("Analyst concludes NVDA leads on CUDA moat; AMD is value.")).toBe(
      false
    );
  });

  test("memory dimension scores higher with hits than empty success", () => {
    const withHits = scoreSoftDimensions({
      ...base(),
      memory: {
        telemetryAvailable: true,
        recallAttempts: 1,
        recallSuccesses: 1,
        recallHits: 5,
        searchAttempts: 0,
        searchSuccesses: 0,
        searchHits: 0,
        errorCount: 0,
      },
    });
    const emptyHits = scoreSoftDimensions({
      ...base(),
      memory: {
        telemetryAvailable: true,
        recallAttempts: 1,
        recallSuccesses: 1,
        recallHits: 0,
        searchAttempts: 0,
        searchSuccesses: 0,
        searchHits: 0,
        errorCount: 0,
      },
    });
    const hitScore = withHits.dimensions.find((d) => d.id === "memory")!.score!;
    const emptyScore = emptyHits.dimensions.find((d) => d.id === "memory")!.score!;
    expect(hitScore).toBeGreaterThan(emptyScore);
  });

  test("recipe recall is half when one of two required tools missed", () => {
    const soft = scoreSoftDimensions({
      ...base(),
      recipe: {
        telemetryAvailable: true,
        requiredTools: ["get_quote", "news"],
        matchedTools: ["get_quote"],
        missedTools: ["news"],
      },
    });
    expect(soft.dimensions.find((d) => d.id === "recipe")?.score).toBe(0.5);
  });
});
