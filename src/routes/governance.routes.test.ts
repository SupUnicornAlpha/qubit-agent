import { describe, expect, test } from "bun:test";
import { governanceRouter } from "./governance.routes";

describe("governance component evidence route", () => {
  test("refuses caller-asserted paper or shadow evidence", async () => {
    const response = await governanceRouter.request("/component-evaluations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "project-1",
        componentKind: "model",
        componentId: "provider",
        versionId: "model-v2",
        comparisonCohortId: "frozen-cohort-1",
        evalKind: "paper",
        sampleSize: 20,
        metrics: {},
        qualityScore: 1,
        pass: true,
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "component_runtime_evidence_must_be_captured_by_authoritative_evaluator",
    });
  });
});
