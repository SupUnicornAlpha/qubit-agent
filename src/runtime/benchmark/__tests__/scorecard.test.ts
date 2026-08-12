import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { L0_CASES, L0_SOFT_CASES, runL0SoftSuite, runL0Suite } from "../l0-suite";
import { QUBIT_BENCH_CASES, QUBIT_BENCH_VERSION, listQubitBenchCases } from "../qubit-bench-cases";
import { enqueueHardFailures } from "../regression-queue";
import { scoreRunEnvelope } from "../scorecard";

describe("qubit benchmark scorecard", () => {
  test("L0 fixtures enforce all v0.1 hard-assertion semantics", () => {
    const results = runL0Suite();
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  test("L0 soft fixtures score memory / orchestration / recipe dimensions", () => {
    const results = runL0SoftSuite();
    expect(results).toHaveLength(L0_SOFT_CASES.length);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  test("soft layer is scored (not skipped) when tools are present", () => {
    const scorecard = scoreRunEnvelope(L0_CASES[0]?.envelope);
    expect(scorecard.layers.soft.status).toBe("scored");
    expect(scorecard.layers.soft.score).not.toBeNull();
    expect(scorecard.layers.soft.dimensions.some((d) => d.id === "tools")).toBe(true);
    expect(scorecard.layers.soft.dimensions.some((d) => d.id === "recipe")).toBe(true);
  });

  test("a hard failure zeros the total score and disqualifies promotion", () => {
    const scorecard = scoreRunEnvelope({
      ...L0_CASES[8]?.envelope,
      workflowRunId: "failed-delivery",
    });
    expect(scorecard.pass).toBe(false);
    expect(scorecard.score).toBe(0);
    expect(scorecard.promotionEligible).toBe(false);
  });

  test("missing telemetry is explicit and cannot qualify a challenger", () => {
    const envelope = {
      ...L0_CASES[0]?.envelope,
      workflowRunId: "missing-telemetry",
    };
    delete envelope.contract;
    const scorecard = scoreRunEnvelope(envelope);
    expect(scorecard.layers.hard.assertions.find((item) => item.id === "H6")?.status).toBe(
      "skipped"
    );
    expect(scorecard.promotionEligible).toBe(false);
  });

  test("production hard failures enter a redacted, idempotent candidate queue", async () => {
    const dir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "qubit-bench-"));
    const queuePath = join(dir, "regressions.jsonl");
    try {
      const scorecard = scoreRunEnvelope({
        ...L0_CASES[8]?.envelope,
        suite: "production",
        workflowRunId: "production-failure",
      });
      expect(
        (await enqueueHardFailures(scorecard, queuePath)).map((item) => item.assertionId)
      ).toEqual(["H2"]);
      expect(await enqueueHardFailures(scorecard, queuePath)).toEqual([]);
      const saved = await readFile(queuePath, "utf8");
      expect(saved).toContain("production-failure");
      expect(saved).not.toContain("recommendation_snapshot");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("qubit-bench-v0.3 is the single 20-case suite with memory/orchestration cases", () => {
    expect(QUBIT_BENCH_VERSION).toBe("qubit-bench-v0.3");
    expect(QUBIT_BENCH_CASES).toHaveLength(20);
    expect(listQubitBenchCases({ tags: ["memory"] }).length).toBeGreaterThanOrEqual(2);
    expect(listQubitBenchCases({ tags: ["orchestration"] }).length).toBeGreaterThanOrEqual(2);
    expect(listQubitBenchCases({ tags: ["portfolio"] }).length).toBeGreaterThanOrEqual(1);
    expect(
      listQubitBenchCases({ dimensions: ["memory"] }).every((c) => c.dimensions.includes("memory"))
    ).toBe(true);
  });
});
