import { isBenchmarkWorkflow } from "./benchmark-namespace";
import { enqueueHardFailures } from "./regression-queue";
import { buildRunEnvelope } from "./run-envelope";
import { scoreRunEnvelope } from "./scorecard";

/** 在 workflow 完结后调用；当前不接入热路径，以免 P0 观测逻辑影响生产执行。 */
export async function scoreProductionRun(input: {
  workflowRunId: string;
  harnessVersion?: string;
}) {
  if (await isBenchmarkWorkflow(input.workflowRunId)) {
    return { skipped: true as const, reason: "benchmark_namespace" as const };
  }
  const envelope = await buildRunEnvelope({ ...input, suite: "production" });
  const scorecard = scoreRunEnvelope(envelope);
  const regressionCandidates = await enqueueHardFailures(scorecard);
  return { envelope, scorecard, regressionCandidates };
}
