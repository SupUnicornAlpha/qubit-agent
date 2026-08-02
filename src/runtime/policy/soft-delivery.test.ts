import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { evaluateDeliveryVerdict } from "./completion";
import { resolveScenarioRecipe } from "./scenario-recipe";
import type { ScenarioRuntimeSnapshot } from "./scenario-snapshot";

function baseSnapshot(
  overrides: Partial<ScenarioRuntimeSnapshot> = {}
): ScenarioRuntimeSnapshot {
  return {
    workflowId: "wf-soft",
    scenarioKey: "stock_pick",
    recipe: resolveScenarioRecipe("stock_pick"),
    authorizedTools: ["run_screener", "recommendation.record"],
    attemptedTools: ["run_screener", "recommendation.record"],
    successfulTools: ["run_screener", "recommendation.record"],
    notAttemptedCapabilities: [],
    unavailableCapabilities: [],
    missingArtifactTables: [],
    missingArtifacts: [],
    artifactsOk: false,
    researchArtifactsOk: true,
    factorDefinitionCount: 0,
    activeFactorIds: [],
    latestFactorDefinitionId: null,
    screenerTopSymbol: "NVDA",
    strategyVersionId: null,
    loadedAtMs: Date.now(),
    ...overrides,
  };
}

describe("soft delivery gates", () => {
  test("answer schema and underfill are soft; researchOk when floor artifacts exist", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE recommendation_snapshot (
        id TEXT, workflow_run_id TEXT, symbol TEXT, side TEXT, rationale TEXT
      );
      CREATE TABLE screener_run (id TEXT, workflow_run_id TEXT);
      CREATE TABLE screener_candidate (id TEXT, screener_run_id TEXT, ticker TEXT, score REAL);
    `);
    sqlite.exec(`
      INSERT INTO screener_run VALUES ('sr1', 'wf-soft');
      INSERT INTO screener_candidate VALUES ('c1', 'sr1', 'NVDA', 1.0);
      INSERT INTO recommendation_snapshot VALUES ('r1', 'wf-soft', 'NVDA', 'long', '');
    `);

    const verdict = evaluateDeliveryVerdict({
      sqlite,
      snapshot: baseSnapshot(),
      answerText: "plain answer without labeled sections",
    });

    expect(verdict.researchOk).toBe(true);
    expect(verdict.upgradeOk).toBe(false);
    expect(verdict.state).toBe("delivered_with_gaps");
    expect(verdict.softReasonCodes).toContain("answer_schema_unsatisfied");
    expect(verdict.softReasonCodes.some((c) => c.startsWith("artifact_underfill:"))).toBe(true);
  });

  test("factor researchOk with definition only (evaluation optional for research)", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE factor_definition (
        id TEXT, workflow_run_id TEXT, name TEXT, expr TEXT, status TEXT
      );
    `);
    sqlite.exec(`
      INSERT INTO factor_definition VALUES ('f1', 'wf-f', 'mom', 'close / Ref(close, 21) - 1', 'draft');
    `);

    const verdict = evaluateDeliveryVerdict({
      sqlite,
      snapshot: baseSnapshot({
        workflowId: "wf-f",
        scenarioKey: "factor",
        recipe: resolveScenarioRecipe("factor"),
        attemptedTools: ["factor.register"],
        successfulTools: ["factor.register"],
        authorizedTools: ["factor.register", "factor.compute"],
        researchArtifactsOk: true,
      }),
      answerText: "no sections",
    });

    expect(verdict.researchOk).toBe(true);
    expect(verdict.state).toBe("delivered_with_gaps");
    expect(verdict.softReasonCodes.some((c) => c.includes("factor_evaluation"))).toBe(true);
  });
});
