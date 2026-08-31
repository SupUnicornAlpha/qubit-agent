import { describe, expect, test } from "bun:test";
import { createFinalHoldoutContract } from "../backtest/final-holdout-contract";
import { buildResearchIntegrityReview } from "./research-integrity-review-service";

describe("research integrity review projection", () => {
  test("keeps incomplete evidence visible without treating it as a promotion", () => {
    const review = buildResearchIntegrityReview({
      strategies: [
        {
          strategyVersionId: "strategy-v1",
          evalKind: "backtest",
          pass: true,
          id: "e1",
          createdAt: "2026-01-01",
        },
      ] as never,
      components: [
        {
          componentKind: "harness",
          componentId: "math-audit",
          versionId: "v1",
          comparisonCohortId: "cohort-1",
          evalKind: "offline",
          sampleSize: 20,
          pass: true,
        },
      ] as never,
    });
    expect(review.readOnly).toBe(true);
    expect(review.strategies[0]?.missingStages).toContain("walk_forward");
    expect(review.components[0]?.promotionState).toBe("evidence_incomplete");
  });

  test("never labels a failed prerequisite as promotion-ready", () => {
    const review = buildResearchIntegrityReview({
      strategies: ["backtest", "walk_forward", "holdout", "paper", "live"].map(
        (evalKind, index) => ({
          strategyVersionId: "strategy-v1",
          evalKind,
          pass: evalKind !== "holdout",
          id: `e${index}`,
          createdAt: `2026-01-0${index + 1}`,
        })
      ) as never,
      components: [],
    });
    expect(review.strategies[0]?.candidateForManualPromotion).toBe(false);
  });

  test("does not splice passing stages from another comparison cohort", () => {
    const strategyVersionId = "strategy-v1";
    const datasetSnapshotId = "snapshot-v1";
    const cohortA = "strategy_cohort_aaaaaaaaaaaaaaaaaaaaaaaa";
    const cohortB = "strategy_cohort_bbbbbbbbbbbbbbbbbbbbbbbb";
    const contract = createFinalHoldoutContract({
      strategyVersionId,
      datasetSnapshotId,
      trainEnd: "2025-01-31",
      holdoutStart: "2025-02-01",
      holdoutEnd: "2025-02-28",
      purgeDays: 5,
      embargoDays: 5,
    });
    const review = buildResearchIntegrityReview({
      strategies: [
        {
          id: "base-a",
          strategyVersionId,
          evalKind: "backtest",
          backtestRunId: "bt-a",
          pass: true,
          createdAt: "2026-01-01",
          metricsJson: {
            datasetSnapshotId,
            comparisonCohort: { id: cohortA },
          },
        },
        {
          id: "walk-b",
          strategyVersionId,
          evalKind: "walk_forward",
          pass: true,
          createdAt: "2026-01-02",
          metricsJson: { comparisonCohort: { id: cohortB } },
        },
        {
          id: "holdout-a",
          strategyVersionId,
          evalKind: "holdout",
          backtestRunId: "bt-a",
          pass: true,
          createdAt: "2026-01-03",
          metricsJson: { contract },
        },
        {
          id: "paper-b",
          strategyVersionId,
          evalKind: "paper",
          pass: true,
          createdAt: "2026-01-04",
          metricsJson: { comparisonCohort: { id: cohortB } },
        },
        {
          id: "live-b",
          strategyVersionId,
          evalKind: "live",
          pass: true,
          createdAt: "2026-01-05",
          metricsJson: { comparisonCohort: { id: cohortB } },
        },
      ] as never,
      components: [],
    });
    const entry = review.strategies.find((item) => item.comparisonCohortId === cohortA);
    expect(entry?.candidateForManualPromotion).toBe(false);
    expect(entry?.missingStages).toEqual(["walk_forward", "paper", "live"]);
  });
});
