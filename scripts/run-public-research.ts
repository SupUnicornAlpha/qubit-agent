import type { ResearchAttempt } from "../src/runtime/research-program/types";
/** Resume the finite, preregistered public-market experiment. No hidden trials or synthetic substitution. */
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { getDb } from "../src/db/sqlite/client";
import { runMigrations } from "../src/db/sqlite/migrate";
import { project } from "../src/db/sqlite/schema";
import {
  DEFAULT_USER_WORKSPACE_ID,
  ensureDefaultUserWorkspace,
} from "../src/runtime/bootstrap/ensure-default-workspace";
import { factorService } from "../src/runtime/factor/factor-service";
import { bootstrapProviders } from "../src/runtime/provider/bootstrap";
import { factorComparisonRunner } from "../src/runtime/research-program/factor-comparison-runner";
import { researchRunner } from "../src/runtime/research-program/runner";
import { researchProgramService } from "../src/runtime/research-program/service";
import { researchStrategyRunner } from "../src/runtime/research-program/strategy-runner";
import { strategyLifecycle } from "../src/runtime/research-program/strategy-lifecycle";
const dir = process.env.QUBIT_DATA_DIR;
if (!dir || !isAbsolute(dir)) throw new Error("absolute_QUBIT_DATA_DIR_required");
const manifest = JSON.parse(await readFile(join(dir, "public-research-manifest.json"), "utf8"));
const statePath = join(dir, "public-research-run.json");
type RunState = {
  projectId: string;
  factors: Array<{ id: string; name: string; expr: string }>;
  attempts: Array<{
    id: string;
    factor: string;
    status: ResearchAttempt["status"];
    result: ResearchAttempt["resultJson"];
    error: string | null;
  }>;
  [key: string]: unknown;
};
const state: RunState = existsSync(statePath)
  ? JSON.parse(await readFile(statePath, "utf8"))
  : { projectId: randomUUID(), factors: [], attempts: [] };
const save = () => writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
await save();
await runMigrations();
await bootstrapProviders();
await ensureDefaultUserWorkspace();
const db = await getDb();
db.insert(project)
  .values({
    id: state.projectId,
    workspaceId: DEFAULT_USER_WORKSPACE_ID,
    name: "真实市场研究 · US 行业 ETF",
    marketScope: "US",
  })
  .onConflictDoNothing()
  .run();
// Publish only development provenance in this project's data catalogue.
const importId = createHash("sha256").update(`${state.projectId}:operator-public-v1`).digest("hex");
await mkdir(join(dir, "research-data-imports"), { recursive: true });
await writeFile(
  join(dir, "research-data-imports", `${importId}.json`),
  JSON.stringify(
    {
      id: importId,
      projectId: state.projectId,
      request: {
        provider: "yahoo_chart",
        ...manifest.development,
        idempotencyKey: "operator-public-v1",
      },
      status: "completed",
      createdAt: manifest.createdAt,
      endedAt: manifest.createdAt,
      snapshotId: manifest.snapshotId,
      provenance: manifest.provenance,
      qualification: "research_only",
      limitations: manifest.limitations,
      barCounts: Object.fromEntries(
        manifest.provenance.map((p: { symbol: string; rows: number }) => [`US:${p.symbol}`, p.rows])
      ),
    },
    null,
    2
  )
);
for (const candidate of [
  { name: "基准：20日动量", expr: manifest.benchmark },
  ...manifest.candidates,
]) {
  if (state.factors.some((f) => f.name === candidate.name)) continue;
  const factor = await factorService.register({
    projectId: state.projectId,
    ...candidate,
    category: "momentum",
    lang: "qlib_expr",
    providerKey: "qlib_expr",
    universe: "US",
    horizon: manifest.horizonDays,
    dryRun: false,
  });
  state.factors.push({ id: factor.id, ...candidate });
  await save();
}
if (!(await researchProgramService.get(state.projectId)).program)
  await researchRunner.createProtocol({
    projectId: state.projectId,
    spec: {
      hypothesis:
        "预先固定的六个动量、反转和低波动候选，在 US 九只行业 ETF 上相对20日动量是否提供跨阶段增量；公开数据仅研究用途。",
      benchmark: "20日动量；策略验证对照相同成本下的等权行业ETF",
      stoppingRule:
        "仅六个预登记候选；不追加或修改参数。30次总预算、2次封存额度；无合格候选则停止晋级。",
      development: { ...manifest.development, datasetSnapshotId: manifest.snapshotId },
      evaluation: {
        method: "factor_rank_ic_v1",
        horizonDays: manifest.horizonDays,
        groupCount: manifest.groupCount,
        sealedDatasetId: manifest.sealedDatasetId,
      },
      comparison: {
        method: "rank_blend_v1",
        references: [{ factorId: state.factors[0].id, direction: 1 }],
        candidateDirection: 1,
        candidateWeight: manifest.candidateWeight,
        costBps: manifest.costBps,
      },
      budget: manifest.budget,
    },
  });
for (const factor of state.factors.slice(1)) {
  const attempt = await factorComparisonRunner.submit({
    projectId: state.projectId,
    factorId: factor.id,
    idempotencyKey: `public-comparison-${factor.id}`,
  });
  const result = await factorComparisonRunner.waitForAttempt(attempt.id);
  state.attempts = state.attempts.filter((a) => a.id !== result.id);
  state.attempts.push({
    id: result.id,
    factor: factor.name,
    status: result.status,
    result: result.resultJson,
    error: result.error,
  });
  await save();
  console.log(
    JSON.stringify({
      factor: factor.name,
      status: result.status,
      verdict: (result.resultJson as { verdict?: string } | null)?.verdict,
      error: result.error,
    })
  );
}
const winner = state.attempts.find(
  (a) => (a.result as { verdict?: string } | null)?.verdict === "worth_validation"
);
if (!winner) {
  state.outcome = "no_candidate_passed_incremental_gate";
  await save();
  console.log(JSON.stringify({ projectId: state.projectId, outcome: state.outcome }));
  process.exit(0);
}
const version = await researchStrategyRunner.create(state.projectId, winner.id, manifest.execution);
state.strategyVersionId = version.id;
await save();
const submitted = await researchStrategyRunner.submit(
  state.projectId,
  version.id,
  "public-first-backtest-v1"
);
await researchStrategyRunner.wait(submitted.jobId);
state.backtestAttemptId = submitted.attemptId;
await save();
console.log(
  JSON.stringify({
    projectId: state.projectId,
    strategyVersionId: version.id,
    backtestAttemptId: submitted.attemptId,
  })
);
let detail = await strategyLifecycle.detail(state.projectId, version.id);
if (!submitted.attemptId || !detail.readyRunIds.includes(submitted.attemptId))
  throw new Error("real_backtest_not_ready");
// Independent deterministic development replay is another charged attempt.
const replay = await researchStrategyRunner.submit(state.projectId, version.id, "public-replay-v1");
const replayJob = await researchStrategyRunner.wait(replay.jobId);
const originalJob = await researchStrategyRunner.wait(submitted.jobId);
const { economicResultDigest } = await import("../src/runtime/research-program/strategy-runner");
if (
  !replayJob.result ||
  !originalJob.result ||
  economicResultDigest(replayJob.result) !== economicResultDigest(originalJob.result)
)
  throw new Error("development_replay_mismatch");
state.replay = {
  attemptId: replay.attemptId,
  matched: true,
  checksum: economicResultDigest(replayJob.result),
};
await save();
if (detail.status === "research")
  detail = await strategyLifecycle.transition(state.projectId, version.id, {
    status: "review",
    referenceAttemptId: submitted.attemptId,
    reason:
      "预登记六候选筛选后首次审查；公开数据缺少时点证明，提交隔离服务仅获取研究诊断，禁止宣称通过。",
    expectedRevision: detail.revision,
  });
const plan = await strategyLifecycle.plan(state.projectId, version.id, detail.revision);
const validation = await strategyLifecycle.validate(
  state.projectId,
  version.id,
  plan.id,
  "public-sealed-strategy-v1"
);
const receipt = await strategyLifecycle.wait(validation.id);
state.validation = { id: receipt.id, status: receipt.status, receipt: receipt.resultJson };
await save();
const factor = state.factors.find((f) => f.id === version.recipe.factor.id);
if (!factor) throw new Error("frozen_factor_missing");
const factorAttempt = await researchRunner.submitFactor({
  projectId: state.projectId,
  factorId: factor.id,
  kind: "sealed_factor",
  idempotencyKey: "public-sealed-factor-v1",
});
const factorReceipt = await researchRunner.waitForAttempt(factorAttempt.id);
state.factorValidation = {
  id: factorReceipt.id,
  status: factorReceipt.status,
  receipt: factorReceipt.resultJson,
};
await save();
const { strategyPaper } = await import("../src/runtime/research-program/strategy-paper");
let sessions = await strategyPaper.list(state.projectId, version.id);
if (!sessions.length) {
  detail = await strategyLifecycle.detail(state.projectId, version.id);
  await strategyPaper.create(state.projectId, version.id, submitted.attemptId, detail.revision);
  sessions = await strategyPaper.list(state.projectId, version.id);
}
const session = sessions[0];
if (!session) throw new Error("paper_session_missing");
state.paperSessionId = session.id;
for (let index = 0; index < 8; index++) {
  const current = (await strategyPaper.list(state.projectId, version.id)).find(
    (s) => s.id === session.id
  );
  if (!current) throw new Error("paper_session_missing");
  if (current.attempts.filter((a) => a.status === "completed").length >= 8) break;
  const attempt = await strategyPaper.advance(state.projectId, version.id, session.id, {
    expectedCursor: current.cursor,
    idempotencyKey: `public-paper-${current.cursor ?? "start"}`,
    bars: 20,
  });
  const finished = await strategyPaper.wait(attempt.id);
  if (finished.status !== "completed") throw new Error(`paper_step_failed:${finished.error}`);
}
const paper = (await strategyPaper.list(state.projectId, version.id))[0];
if (!paper) throw new Error("paper_session_missing");
state.paper = {
  cursor: paper.cursor,
  attempts: paper.attempts.map((a) => ({ id: a.id, status: a.status, result: a.resultJson })),
};
detail = await strategyLifecycle.detail(state.projectId, version.id);
if (paper.status !== "paused")
  await strategyPaper.setStatus(
    state.projectId,
    version.id,
    paper.id,
    "paused",
    detail.revision,
    false
  );
const artifact = await researchStrategyRunner.artifact(state.projectId, version.id);
await writeFile(
  join(dir, "public-research-strategy-artifact.json"),
  JSON.stringify(artifact, null, 2),
  { mode: 0o600 }
);
state.outcome = "completed_research_only";
state.finishedAt = new Date().toISOString();
await save();
console.log(
  JSON.stringify(
    {
      projectId: state.projectId,
      strategyVersionId: version.id,
      outcome: state.outcome,
      backtest: originalJob.result.metrics,
      replay: state.replay,
      validation: state.validation,
      factorValidation: state.factorValidation,
      paperCursor: paper.cursor,
    },
    null,
    2
  )
);
