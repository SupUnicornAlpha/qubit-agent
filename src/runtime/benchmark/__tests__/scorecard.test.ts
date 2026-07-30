import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { L0_CASES, runL0Suite } from "../l0-suite";
import { enqueueHardFailures } from "../regression-queue";
import { scoreRunEnvelope } from "../scorecard";

describe("qubit benchmark scorecard", () => {
  test("L0 fixtures enforce all v0.1 hard-assertion semantics", () => {
    const results = runL0Suite();
    expect(results).toHaveLength(10);
    expect(results.every((result) => result.pass)).toBe(true);
  });

  test("a hard failure zeros the total score and disqualifies promotion", () => {
    const scorecard = scoreRunEnvelope({
      ...L0_CASES[8]!.envelope,
      workflowRunId: "failed-delivery",
    });
    expect(scorecard.pass).toBe(false);
    expect(scorecard.score).toBe(0);
    expect(scorecard.promotionEligible).toBe(false);
  });

  test("missing telemetry is explicit and cannot qualify a challenger", () => {
    const envelope = {
      ...L0_CASES[0]!.envelope,
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
        ...L0_CASES[8]!.envelope,
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
});
