import { describe, expect, test } from "bun:test";
import { harnessRouter } from "../../routes/harness.routes";
import { createBuiltinFinancialHarnessRegistry } from "./builtin-financial-capabilities";
import { buildHarnessCapabilityCatalog } from "./capability-catalog";

describe("Harness capability catalog", () => {
  const catalog = buildHarnessCapabilityCatalog();
  const registry = createBuiltinFinancialHarnessRegistry();

  test("exposes workflow-leased math and integrity profiles from the live registry", () => {
    const math = catalog.profiles.find((profile) => profile.profileId === "math-audit");
    const integrity = catalog.profiles.find(
      (profile) => profile.profileId === "quant-research-integrity"
    );
    expect(math?.admission).toMatchObject({
      kind: "workflow_lease",
      configKey: "harness.mathAudit",
    });
    expect(math?.tools).toEqual(["math.derivation.verify"]);
    expect(registry.getProfile("math-audit")?.parameters).toBeUndefined();
    expect(registry.getProfile("quant-research-integrity")?.parameters).toBeUndefined();
    expect(integrity?.admission.kind).toBe("workflow_lease");
    expect(integrity?.capabilities.map((item) => item.id)).toContain("quant.research-integrity");
    expect(integrity?.evidenceStages?.map((stage) => stage.stage)).toEqual([
      "research",
      "paper",
      "live",
    ]);
    expect(
      integrity?.evidenceStages
        ?.find((stage) => stage.stage === "live")
        ?.checks.map((check) => check.id)
    ).toEqual([
      "validationQualifiedDataset",
      "backtestIntegrity",
      "factorRiskExposure",
      "walkForward",
      "finalHoldout",
      "paper",
      "humanApproval",
    ]);
  });

  test("makes paper inherit the integrity overlay without turning host adapters into profiles", () => {
    const paper = catalog.profiles.find((profile) => profile.profileId === "paper-trading");
    expect(paper?.extends).toContain("quant-research-integrity");
    expect(paper?.capabilities.map((item) => item.id)).toContain("quant.research-integrity");
    expect(catalog.hostGates.map((gate) => gate.id)).toEqual([
      "anti-leakage-v2",
      "statistical-validation-v3",
      "asset-lifecycle-v2",
      "exchange-calendar-release",
      "live-account-risk",
      "live-pre-trade-rules",
      "live-runtime-guardrails",
      "trading-module-control",
      "final-holdout",
      "tca-execution-quality",
    ]);
    expect(catalog.hostGates.every((gate) => gate.toggleable === false)).toBe(true);
    expect(catalog.hostGates.find((gate) => gate.id === "tca-execution-quality")?.role).toBe(
      "observation"
    );
    expect(
      catalog.hostGates.filter((gate) => gate.role === "gate").map((gate) => gate.id)
    ).not.toContain("tca-execution-quality");
    expect(
      catalog.hostGates.find((gate) => gate.id === "live-account-risk")?.failClosedWhenMissing
    ).toBe(true);
  });

  test("profiles API returns the same inspection for operators", async () => {
    const response = await harnessRouter.request("http://qubit.test/profiles");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        available: Array<{
          id: string;
          admission?: { kind: string };
          evidenceStages?: Array<{ stage: string }>;
          parameters?: Array<{ id: string }>;
        }>;
        hostGates: Array<{ id: string; toggleable: boolean }>;
      };
    };
    const mathProfile = body.data.available.find((item) => item.id === "math-audit");
    const integrity = body.data.available.find((item) => item.id === "quant-research-integrity");
    expect(mathProfile?.admission?.kind).toBe("workflow_lease");
    expect(mathProfile?.parameters ?? []).toEqual([]);
    expect(integrity?.parameters ?? []).toEqual([]);
    expect(integrity?.admission?.kind).toBe("workflow_lease");
    expect(integrity?.evidenceStages?.map((stage) => stage.stage)).toEqual([
      "research",
      "paper",
      "live",
    ]);
    expect(body.data.hostGates.every((gate) => gate.toggleable === false)).toBe(true);
    expect(body.data.hostGates.map((gate) => gate.id)).toContain("live-account-risk");
  });
});
