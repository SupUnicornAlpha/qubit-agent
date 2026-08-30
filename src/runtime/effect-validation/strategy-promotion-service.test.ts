import { describe, expect, test } from "bun:test";
import type { strategyEvalRun } from "../../db/sqlite/schema";
import { createFinalHoldoutContract } from "../backtest/final-holdout-contract";
import {
  buildStrategyVersionScorecards,
  hasPassedFactorRiskExposure,
} from "./strategy-promotion-service";

const cohort = "strategy_cohort_0123456789abcdef01234567";

function evaluation(
  strategyVersionId: string,
  evalKind: typeof strategyEvalRun.$inferSelect.evalKind,
  qualityScore: number,
  pass = true,
  createdAt = "2026-07-13T00:00:00.000Z"
): typeof strategyEvalRun.$inferSelect {
  const backtestRunId = `backtest-${strategyVersionId}`;
  const datasetSnapshotId = `snapshot-${strategyVersionId}`;
  return {
    id: `${strategyVersionId}-${evalKind}-${createdAt}`,
    workflowRunId: null,
    projectId: "p",
    strategyVersionId,
    compositionId: null,
    backtestRunId: evalKind === "backtest" || evalKind === "holdout" ? backtestRunId : null,
    scenarioKey: "test",
    evalKind,
    periodStart: null,
    periodEnd: null,
    metricsJson:
      evalKind === "backtest"
        ? {
            datasetSnapshotId,
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
        : evalKind === "holdout"
          ? {
              contract: createFinalHoldoutContract({
                strategyVersionId,
                datasetSnapshotId,
                trainEnd: "2026-01-31",
                holdoutStart: "2026-02-06",
                holdoutEnd: "2026-02-28",
                purgeDays: 5,
                embargoDays: 5,
              }),
            }
          : {},
    qualityScore,
    pass,
    notes: "",
    createdBy: "test",
    createdAt,
  };
}

function requiredScorecard(
  rows: Array<typeof strategyEvalRun.$inferSelect>,
  comparisonCohortId?: string
) {
  const [scorecard] = buildStrategyVersionScorecards(rows, comparisonCohortId);
  if (!scorecard) throw new Error("expected strategy scorecard");
  return scorecard;
}

describe("strategy champion challenger scorecards", () => {
  test("requires passed risk evidence only when a factor composition declares it", () => {
    expect(
      hasPassedFactorRiskExposure({ factorRiskExposure: { required: true, status: "incomplete" } })
    ).toBe(false);
    expect(
      hasPassedFactorRiskExposure({ factorRiskExposure: { required: true, status: "passed" } })
    ).toBe(true);
    expect(hasPassedFactorRiskExposure({})).toBe(true);
  });
  test("weights backtest, walk-forward, final holdout and paper scores", () => {
    const rows = [
      evaluation("v1", "backtest", 0.7),
      evaluation("v1", "walk_forward", 0.8),
      evaluation("v1", "holdout", 1),
      evaluation("v1", "paper", 0.9),
      evaluation("v1", "paper", 0.95, true, "2026-07-13T01:00:00.000Z"),
    ];
    const scorecard = requiredScorecard(rows);
    expect(scorecard.paperScore).toBe(0.95);
    expect(scorecard.score).toBe(0.865);
    expect(scorecard.allPrerequisitesPassed).toBe(true);
  });

  test("does not qualify versions missing paper validation", () => {
    const scorecard = requiredScorecard([
      evaluation("v2", "backtest", 1),
      evaluation("v2", "walk_forward", 1),
    ]);
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
    const scorecard = requiredScorecard([
      backtest,
      evaluation("v3", "walk_forward", 1),
      evaluation("v3", "paper", 1),
    ]);
    expect(scorecard.allPrerequisitesPassed).toBe(false);
  });

  test("only exposes a common fixed cohort when backtest, walk-forward and paper agree", () => {
    const rows = [
      evaluation("v4", "backtest", 0.8),
      evaluation("v4", "walk_forward", 0.8),
      evaluation("v4", "holdout", 0.8),
      evaluation("v4", "paper", 0.8),
    ];
    for (const row of rows) {
      row.metricsJson = {
        ...(row.metricsJson as Record<string, unknown>),
        comparisonCohort: { id: cohort },
      };
    }
    const matching = requiredScorecard(rows, cohort);
    expect(matching.comparisonCohortIds).toEqual([cohort]);
    expect(matching.allPrerequisitesPassed).toBe(true);

    const paper = rows.find((row) => row.evalKind === "paper");
    if (!paper) throw new Error("expected paper evaluation");
    paper.metricsJson = { comparisonCohort: { id: "strategy_cohort_abcdef0123456789abcdef01" } };
    expect(requiredScorecard(rows).comparisonCohortIds).toEqual([]);
  });
});
