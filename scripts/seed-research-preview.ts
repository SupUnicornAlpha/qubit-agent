/** Explicit, isolated synthetic preview. Never called by application startup. */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
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
import { buildIncrementalPreviewSnapshot } from "../src/runtime/research-program/fixtures/incremental-preview";
import { researchRunner } from "../src/runtime/research-program/runner";

const dir = process.env.QUBIT_DATA_DIR;
if (process.env.QUBIT_RESEARCH_PREVIEW !== "1" || !dir || !isAbsolute(dir)) {
  throw new Error(
    "Set QUBIT_RESEARCH_PREVIEW=1 and an absolute QUBIT_DATA_DIR for an isolated preview."
  );
}
const manifest = join(dir, "research-preview.json");
if (existsSync(manifest)) {
  console.log(await readFile(manifest, "utf8"));
} else {
  // Refuse to add synthetic experiments to an existing database.
  if (existsSync(join(dir, "db", "core.sqlite")))
    throw new Error("Preview requires a new data directory.");
  await runMigrations();
  await bootstrapProviders();
  const db = await getDb();
  const workspaceId = DEFAULT_USER_WORKSPACE_ID;
  const projectId = randomUUID();
  await ensureDefaultUserWorkspace();
  db.insert(project)
    .values({ id: projectId, workspaceId, name: "增量评估演示 · 合成数据", marketScope: "US" })
    .run();
  const fixture = buildIncrementalPreviewSnapshot();
  await mkdir(join(dir, "market-snapshots"), { recursive: true });
  await writeFile(
    join(dir, "market-snapshots", `${fixture.record.snapshot.snapshotId}.json`),
    JSON.stringify(fixture.record)
  );
  const factors = [];
  for (const [name, expr] of [
    ["基准：5日动量", "close/Ref(close,5)-1"],
    ["应拦截：未来数据", "Ref(close,-1)"],
    ["重复表达式", "$close / Ref($close, 5) - 1"],
    ["不同公式、相同排序", "2*(close/Ref(close,5)-1)"],
    ["合成预测信号", "volume"],
  ] as const) {
    factors.push(
      await factorService.register({
        projectId,
        name,
        expr,
        category: "momentum",
        lang: "qlib_expr",
        providerKey: "qlib_expr",
        universe: "US",
        dryRun: false,
      })
    );
  }
  await researchRunner.createProtocol({
    projectId,
    spec: {
      hypothesis: "仅检验研究流程：合成预测信号相对固定动量基准是否提供增量。不是市场实证。",
      benchmark: "固定5日动量排序组合",
      stoppingRule: "预算100次；演示不提交封存验证",
      development: {
        datasetSnapshotId: fixture.record.snapshot.snapshotId,
        symbols: fixture.symbols,
        startDate: fixture.startDate,
        endDate: fixture.endDate,
      },
      evaluation: { method: "factor_rank_ic_v1", horizonDays: 1, groupCount: 5 },
      comparison: {
        method: "rank_blend_v1",
        references: [{ factorId: factors[0]?.id, direction: 1 }],
        candidateDirection: 1,
        candidateWeight: 0.25,
        costBps: 10,
      },
      budget: { maxAttempts: 100, maxEvaluations: 0 },
    },
  });
  const attempts = [];
  for (const factor of factors.slice(1)) {
    const attempt = await factorComparisonRunner.submit({
      projectId,
      factorId: factor.id,
      idempotencyKey: `preview-${factor.id}`,
    });
    const result = await factorComparisonRunner.waitForAttempt(attempt.id);
    attempts.push({ id: result.id, factor: factor.name, status: result.status });
  }
  const result = {
    synthetic: true,
    projectId,
    workspaceId,
    factors: factors.map((f) => ({ id: f.id, name: f.name })),
    attempts,
  };
  await writeFile(manifest, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
