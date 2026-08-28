import { describe, expect, test } from "bun:test";
import type { strategyEvalRun } from "../../db/sqlite/schema";
import { buildStrategyVersionScorecards } from "./strategy-promotion-service";

function evaluation(
  strategyVersionId: string,
  evalKind: typeof strategyEvalRun.$inferSelect.evalKind,
  qualityScore: number,
  pass = true,
  createdAt = "2026-07-13T00:00:00.000Z"
): typeof strategyEvalRun.$inferSelect {
  return {
    id: `${strategyVersionId}-${evalKind}-${createdAt}`,
    workflowRunId: null,
    projectId: "p",
    strategyVersionId,
    compositionId: null,
    backtestRunId: null,
    scenarioKey: "test",
    evalKind,
    periodStart: null,
    periodEnd: null,
    metricsJson:
      evalKind === "backtest"
        ? {
            datasetQualification: {
              useClass: "strategy_validation",
              universeHistory: "verified",
              corporateActions: "verified",
              pointInTime: "verified",
            },
            antiLeakageReport: { status: "passed" },
            pitReport: { pass: true, verdict: "point_in_time_clean" },
            statisticalValidationReport: { status: "passed" },
          }
        : {},
    qualityScore,
    pass,
    notes: "",
    createdBy: "test",
    createdAt,
  };
}

describe("strategy champion challenger scorecards", () => {
  test("weights latest backtest, walk-forward and paper scores", () => {
    const rows = [
      evaluation("v1", "backtest", 0.7),
      evaluation("v1", "walk_forward", 0.8),
      evaluation("v1", "paper", 0.9),
      evaluation("v1", "paper", 0.95, true, "2026-07-13T01:00:00.000Z"),
    ];
    const scorecard = buildStrategyVersionScorecards(rows)[0]!;
    expect(scorecard.paperScore).toBe(0.95);
    expect(scorecard.score).toBe(0.835);
    expect(scorecard.allPrerequisitesPassed).toBe(true);
  });

  test("does not qualify versions missing paper validation", () => {
    const scorecard = buildStrategyVersionScorecards([
      evaluation("v2", "backtest", 1),
      evaluation("v2", "walk_forward", 1),
    ])[0]!;
    expect(scorecard.allPrerequisitesPassed).toBe(false);
  });

  test("does not let a research-only backtest pass the promotion prerequisite", () => {
    const backtest = evaluation("v3", "backtest", 1);
    backtest.metricsJson = {
      datasetQualification: {
        useClass: "research_only",
        universeHistory: "not_verified",
        corporateActions: "not_verified",
        pointInTime: "verified",
      },
    };
    const scorecard = buildStrategyVersionScorecards([
      backtest,
      evaluation("v3", "walk_forward", 1),
      evaluation("v3", "paper", 1),
    ])[0]!;
    expect(scorecard.allPrerequisitesPassed).toBe(false);
  });
});
