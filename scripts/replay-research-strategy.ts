import { randomUUID } from "node:crypto";
import { backtestJobService } from "../src/runtime/backtest/backtest-job-service";
import { bootstrapProviders } from "../src/runtime/provider/bootstrap";
import {
  economicResultDigest,
  researchStrategyRunner,
} from "../src/runtime/research-program/strategy-runner";

const [projectId, versionId, referenceJobId] = process.argv.slice(2);
if (!process.env.QUBIT_DATA_DIR || !projectId || !versionId)
  throw new Error(
    "Set QUBIT_DATA_DIR explicitly. Usage: bun scripts/replay-research-strategy.ts <projectId> <versionId> [referenceJobId]. Every replay consumes one research attempt."
  );
await researchStrategyRunner.get(projectId, versionId);
const reference = referenceJobId ? await backtestJobService.get(referenceJobId) : null;
if (
  reference &&
  (reference.strategyVersionId !== versionId ||
    reference.status !== "completed" ||
    !reference.result)
)
  throw new Error("Reference must be a completed backtest of this exact strategy version.");
await bootstrapProviders();
const submitted = await researchStrategyRunner.submit(
  projectId,
  versionId,
  `replay-${randomUUID()}`
);
const job = await researchStrategyRunner.wait(submitted.jobId);
if (job.status !== "completed" || !job.result || job.result.error)
  throw new Error(`Replay failed: ${job.result?.error ?? job.status}`);
const checksum = economicResultDigest(job.result);
const matches = reference?.result ? checksum === economicResultDigest(reference.result) : null;
console.log(
  JSON.stringify(
    {
      jobId: job.id,
      attemptId: submitted.attemptId,
      checksum,
      matchesReference: matches,
      scope: "development_only",
      tradingEligible: false,
    },
    null,
    2
  )
);
if (matches === false) process.exitCode = 1;
