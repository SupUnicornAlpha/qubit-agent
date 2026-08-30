import { expect, test } from "bun:test";
import { createFinalHoldoutContract, matchesFinalHoldoutEvidence } from "./final-holdout-contract";
test("final holdout is after training and fingerprinted", () => {
  const r = createFinalHoldoutContract({
    strategyVersionId: "sv",
    datasetSnapshotId: "snap",
    trainEnd: "2026-01-10",
    holdoutStart: "2026-01-16",
    holdoutEnd: "2026-01-31",
    purgeDays: 5,
    embargoDays: 5,
  });
  expect(r.fingerprint).toMatch(/^holdout_/);
});
test("final holdout rejects overlap with its training window", () => {
  expect(() =>
    createFinalHoldoutContract({
      strategyVersionId: "sv",
      datasetSnapshotId: "snap",
      trainEnd: "2026-01-10",
      holdoutStart: "2026-01-10",
      holdoutEnd: "2026-01-31",
      purgeDays: 5,
      embargoDays: 5,
    })
  ).toThrow("final_holdout_dates_not_strictly_after_training");
});

test("final holdout rejects non-ISO dates before creating a fingerprint", () => {
  expect(() =>
    createFinalHoldoutContract({
      strategyVersionId: "sv",
      datasetSnapshotId: "snap",
      trainEnd: "2026/01/10",
      holdoutStart: "2026-01-16",
      holdoutEnd: "2026-01-31",
      purgeDays: 5,
      embargoDays: 5,
    })
  ).toThrow("final_holdout_date_invalid");
});

test("final holdout evidence requires an untampered contract for the same strategy and snapshot", () => {
  const contract = createFinalHoldoutContract({
    strategyVersionId: "strategy-v1",
    datasetSnapshotId: "snapshot-v1",
    trainEnd: "2026-01-31",
    holdoutStart: "2026-02-06",
    holdoutEnd: "2026-02-28",
    purgeDays: 5,
    embargoDays: 5,
  });
  expect(
    matchesFinalHoldoutEvidence(
      { contract },
      { strategyVersionId: "strategy-v1", datasetSnapshotId: "snapshot-v1" }
    )
  ).toBe(true);
  expect(
    matchesFinalHoldoutEvidence(
      { contract: { ...contract, holdoutEnd: "2026-03-03" } },
      { strategyVersionId: "strategy-v1", datasetSnapshotId: "snapshot-v1" }
    )
  ).toBe(false);
  expect(
    matchesFinalHoldoutEvidence(
      { contract },
      { strategyVersionId: "strategy-v1", datasetSnapshotId: "snapshot-v2" }
    )
  ).toBe(false);
});
