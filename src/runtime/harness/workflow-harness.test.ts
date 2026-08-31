import { describe, expect, test } from "bun:test";
import { resolveWorkflowHarnessAdmission } from "./workflow-harness";

describe("workflow-scoped math Harness admission", () => {
  test("keeps ordinary conversations fully inert", () => {
    expect(
      resolveWorkflowHarnessAdmission({
        mode: "research",
        researchScenarioId: "conversational_research",
        loopOptionsJson: {},
        status: "running",
      })
    ).toMatchObject({ math: null, researchIntegrity: null });
  });

  test("admits an explicit advisory lease without inspecting user prose", () => {
    const admission = resolveWorkflowHarnessAdmission({
      mode: "research",
      researchScenarioId: "conversational_research",
      loopOptionsJson: {
        harness: { mathAudit: { mode: "advisory", reason: "validated pricing derivation" } },
      },
      status: "running",
    });
    expect(admission.math).toMatchObject({
      profileId: "math-audit",
      mode: "advisory",
      source: "workflow_config",
    });
  });

  test("makes registered factor and backtest workflows required by default", () => {
    const factor = resolveWorkflowHarnessAdmission({
      mode: "research",
      researchScenarioId: "factor_research",
      loopOptionsJson: {},
      status: "running",
    });
    expect(factor.math).toMatchObject({ mode: "required", source: "research_scenario" });
    expect(factor.researchIntegrity).toMatchObject({
      profileId: "quant-research-integrity",
      mode: "advisory",
      source: "research_scenario",
    });
    const backtest = resolveWorkflowHarnessAdmission({
      mode: "backtest",
      researchScenarioId: null,
      loopOptionsJson: {},
      status: "running",
    });
    expect(backtest.math).toMatchObject({ mode: "required", source: "workflow_mode" });
    expect(backtest.researchIntegrity).toMatchObject({ mode: "required", source: "workflow_mode" });
  });

  test("allows an explicit off override and releases terminal workflows", () => {
    expect(
      resolveWorkflowHarnessAdmission({
        mode: "backtest",
        researchScenarioId: "factor_research",
        loopOptionsJson: { harness: { mathAudit: { mode: "off", reason: "manual disable" } } },
        status: "running",
      }).math
    ).toBeNull();
    expect(
      resolveWorkflowHarnessAdmission({
        mode: "live",
        researchScenarioId: "live_trading",
        loopOptionsJson: {
          harness: { researchIntegrity: { mode: "off", reason: "report intentionally hidden" } },
        },
        status: "running",
      }).researchIntegrity
    ).toBeNull();
    expect(
      resolveWorkflowHarnessAdmission({
        mode: "backtest",
        researchScenarioId: "factor_research",
        loopOptionsJson: {},
        status: "completed",
      }).math
    ).toBeNull();
  });
});
