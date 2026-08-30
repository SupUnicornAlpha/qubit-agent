import { describe, expect, test } from "bun:test";
import { assessQuantResearchIntegrity } from "./quant-research-integrity";

const completeEvidence = {
  validationQualifiedDataset: true,
  backtestIntegrity: true,
  factorRiskExposure: true,
  walkForward: true,
  finalHoldout: true,
  paper: true,
  humanApproval: true,
};

describe("quant research integrity Harness policy", () => {
  test("keeps incomplete research advisory rather than granting an execution permission", () => {
    const assessment = assessQuantResearchIntegrity({
      stage: "research",
      evidence: { ...completeEvidence, backtestIntegrity: false },
    });

    expect(assessment.enforcement).toBe("advisory");
    expect(assessment.passed).toBe(false);
    expect(assessment.missingChecks).toEqual(["backtestIntegrity"]);
  });

  test("requires frozen evidence, OOS and paper evidence before live", () => {
    const assessment = assessQuantResearchIntegrity({
      stage: "live",
      evidence: { ...completeEvidence, walkForward: false, humanApproval: false },
    });

    expect(assessment.enforcement).toBe("required");
    expect(assessment.passed).toBe(false);
    expect(assessment.missingChecks).toEqual(["walkForward", "humanApproval"]);
  });

  test("accepts a complete live evidence chain", () => {
    expect(assessQuantResearchIntegrity({ stage: "live", evidence: completeEvidence }).passed).toBe(
      true
    );
  });
});
