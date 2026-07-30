import { describe, expect, test } from "bun:test";
import type { ReadinessSnapshot, SnapshotGrade } from "../../agent-readiness/grader";
import { L0_CASES } from "../l0-suite";
import { QUBIT_BENCH_CASES } from "../qubit-bench-cases";
import { scoreRunEnvelope } from "../scorecard";
import { evaluateUpgradeGate } from "../upgrade-gate";

const benchmarkCase = QUBIT_BENCH_CASES[0]!;

function snapshot(overrides: Partial<Record<string, number | null>> = {}): ReadinessSnapshot {
  return {
    workflowRunId: "benchmark-run",
    scenario: benchmarkCase.scenarioKey,
    capturedAt: "2026-07-29T00:00:00.000Z",
    workflowStatus: "completed",
    metrics: {
      "A-1": 1,
      "A-2": 0.8,
      "A-5": 1,
      "B-1": 1,
      "B-2": 1,
      "B-3": 0.02,
      "B-7": 2,
      "C-3-total": 10_000,
      "C-3-p95": 4_000,
      "D-2": 0.5,
      ...overrides,
    },
  };
}

const grade = { weightedScore: 1 } as SnapshotGrade;

function completeScorecard() {
  return scoreRunEnvelope({
    ...L0_CASES[0]!.envelope,
    suite: "L1",
    workflowRunId: "benchmark-run",
    scenarioKey: benchmarkCase.scenarioKey,
    risk: { telemetryAvailable: true, decisionRecorded: true },
    shortRisk: { telemetryAvailable: true, coverageRecorded: true },
  });
}

describe("benchmark upgrade gate", () => {
  test("passes a fully observed, budget-compliant benchmark", () => {
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot(),
      grade,
      scorecard: completeScorecard(),
      durationMs: 1_000,
    });
    expect(result.status).toBe("pass");
    expect(result.promotionEligible).toBe(true);
  });

  test("fails an upgrade when token consumption exceeds the case budget", () => {
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot({ "C-3-total": benchmarkCase.budget.maxTotalTokens + 1 }),
      grade,
      scorecard: completeScorecard(),
      durationMs: 1_000,
    });
    expect(result.status).toBe("fail");
    expect(result.dimensions.find((item) => item.name === "resource")?.status).toBe("fail");
  });

  test("marks telemetry gaps incomplete instead of granting a false pass", () => {
    const {
      contract: _contract,
      capability: _capability,
      ...withoutTelemetry
    } = L0_CASES[0]!.envelope;
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot(),
      grade,
      scorecard: scoreRunEnvelope({ ...withoutTelemetry, suite: "L1" }),
      durationMs: 1_000,
    });
    expect(result.status).toBe("incomplete");
    expect(result.promotionEligible).toBe(false);
  });
});
