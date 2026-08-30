import { describe, expect, test } from "bun:test";
import {
  QUBIT_REASONING_HARNESS,
  resolveReasoningHarnessMode,
  resolveReasoningHarnessModeFromTaskMetadata,
} from "./reasoning-harness";

describe("Qubit Reasoning Harness activation", () => {
  test("uses a product-owned provider-neutral identity", () => {
    expect(QUBIT_REASONING_HARNESS.title).toBe("Qubit Reasoning Harness");
    expect(QUBIT_REASONING_HARNESS.id).not.toContain("deepseek");
  });

  test("leaves a disabled profile and normal conversations inert", () => {
    expect(
      resolveReasoningHarnessMode({
        capabilityEnabled: false,
        requestedMode: "required",
        workflowKind: "strategy",
        hasMathematicalClaim: true,
        affectsDecision: true,
      })
    ).toBe("off");
    expect(
      resolveReasoningHarnessMode({ capabilityEnabled: true, hasMathematicalClaim: true })
    ).toBe("off");
  });

  test("requires verification only for an admitted mathematical decision workflow", () => {
    expect(
      resolveReasoningHarnessMode({
        capabilityEnabled: true,
        workflowKind: "options",
        hasMathematicalClaim: true,
        affectsDecision: true,
      })
    ).toBe("required");
  });

  test("uses only explicit workflow metadata and accepts canonical high-assurance aliases", () => {
    expect(
      resolveReasoningHarnessModeFromTaskMetadata({
        capabilityEnabled: true,
        metadata: {
          taskType: "factor_research",
          hasMathematicalClaim: true,
          affectsDecision: true,
        },
      })
    ).toBe("required");
    expect(
      resolveReasoningHarnessModeFromTaskMetadata({
        capabilityEnabled: true,
        metadata: { goal: "请推导波动率公式" },
      })
    ).toBe("off");
    expect(
      resolveReasoningHarnessModeFromTaskMetadata({
        capabilityEnabled: true,
        metadata: { math_mode: "advisory" },
      })
    ).toBe("advisory");
  });
});
