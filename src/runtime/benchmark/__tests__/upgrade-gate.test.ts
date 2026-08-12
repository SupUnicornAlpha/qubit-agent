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
    ...L0_CASES[0]?.envelope,
    suite: "L1",
    workflowRunId: "benchmark-run",
    scenarioKey: benchmarkCase.scenarioKey,
    risk: { telemetryAvailable: true, decisionRecorded: true },
    shortRisk: { telemetryAvailable: true, coverageRecorded: true },
    deliveryVerdict: {
      available: true,
      state: "delivered",
      reasonCodes: [],
    },
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
    expect(result.researchSuccess).toBe("pass");
  });

  test("researchSuccess can pass when upgrade quality is soft on A-2", () => {
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot({ "A-2": 0 }),
      grade: { weightedScore: 0.5 } as SnapshotGrade,
      scorecard: completeScorecard(),
      durationMs: 1_000,
    });
    // Soft quality: A-1=1 + A-2=0 still passes quality with soft_quality detail.
    expect(result.dimensions.find((d) => d.name === "quality")?.status).toBe("pass");
    expect(result.researchSuccess).toBe("pass");
  });

  test("soft-over token consumption still passes resource (does not block research)", () => {
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot({ "C-3-total": benchmarkCase.budget.maxTotalTokens + 1 }),
      grade,
      scorecard: completeScorecard(),
      durationMs: 1_000,
    });
    expect(result.status).toBe("pass");
    const resource = result.dimensions.find((item) => item.name === "resource");
    expect(resource?.status).toBe("pass");
    expect(resource?.detail.startsWith("soft_over")).toBe(true);
  });

  test("fails resource only on hard overrun (3x budget or iteration blow-up)", () => {
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot({ "C-3-total": benchmarkCase.budget.maxTotalTokens * 3 + 1 }),
      grade,
      scorecard: completeScorecard(),
      durationMs: 1_000,
    });
    expect(result.status).toBe("fail");
    expect(result.dimensions.find((item) => item.name === "resource")?.status).toBe("fail");
  });

  test("telemetry gaps are soft on observability but still block promotion", () => {
    const {
      contract: _contract,
      capability: _capability,
      ...withoutTelemetry
    } = L0_CASES[0]?.envelope;
    const result = evaluateUpgradeGate({
      benchmarkCase,
      snapshot: snapshot(),
      grade,
      scorecard: scoreRunEnvelope({
        ...withoutTelemetry,
        suite: "L1",
        deliveryVerdict: {
          available: true,
          state: "delivered_with_gaps",
          reasonCodes: ["answer_schema_unsatisfied"],
        },
      }),
      durationMs: 1_000,
    });
    expect(result.status).toBe("pass");
    expect(result.dimensions.find((d) => d.name === "observability")?.detail).toContain(
      "telemetry_soft_missing"
    );
    expect(result.promotionEligible).toBe(false);
  });

  test("memory dimension fails when recall is required but never attempted", () => {
    const memCase = QUBIT_BENCH_CASES.find((c) => c.id === "QB-MEM-01")!;
    const result = evaluateUpgradeGate({
      benchmarkCase: memCase,
      snapshot: snapshot(),
      grade,
      scorecard: completeScorecard(),
      durationMs: 1_000,
    });
    expect(result.dimensions.find((d) => d.name === "memory")?.status).toBe("fail");
    expect(result.status).toBe("fail");
  });
});
