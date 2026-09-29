import { beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { project, workspace } from "../../db/sqlite/schema";
import { researchProgramRouter } from "../../routes/research-program.routes";
import { defaultDataDir } from "../app-paths";
import { factorService } from "../factor/factor-service";
import { buildMarketSnapshotRecord } from "../market/contracts/market-snapshot-service";
import { bootstrapProviders } from "../provider/bootstrap";
import { SealedEvaluatorClient } from "./evaluator-client";
import { executeResearchAttempt } from "./execution";
import { ResearchRunner, researchRunner } from "./runner";
import { canonicalSealedJson, createSealedEvaluator } from "./sealed-evaluator";
import { researchProgramService } from "./service";
import type { ResearchProtocolSpec } from "./types";

const workspaceId = randomUUID();
let snapshotId = "";
beforeAll(async () => {
  await runMigrations();
  await bootstrapProviders();
  (await getDb())
    .insert(workspace)
    .values({ id: workspaceId, name: "Research runner test", owner: "test" })
    .run();
  const symbols = ["AAA", "BBB", "CCC"];
  const record = buildMarketSnapshotRecord({
    asOf: "2025-05-01T00:00:00.000Z",
    purpose: "backtest",
    timeframe: "1d",
    limit: 100,
    instruments: symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" as const })),
    sources: [{ provider: "runner-fixture", feed: "fixture", upstreamFamily: "fixture" }],
    window: { start: "2025-01-01", end: "2025-04-10" },
    barsByInstrument: Object.fromEntries(
      symbols.map((symbol, offset) => [
        `US:${symbol}`,
        Array.from({ length: 100 }, (_, i) => {
          const close = 100 + i * (offset + 1) + Math.sin(i);
          return {
            timestamp: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
            open: close,
            high: close + 1,
            low: close - 1,
            close,
            volume: 100,
            turnover: close * 100,
          };
        }),
      ])
    ),
  });
  snapshotId = record.snapshot.snapshotId;
  const dir = join(defaultDataDir(), "market-snapshots");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${snapshotId}.json`), JSON.stringify(record));
});
function spec(): ResearchProtocolSpec {
  return {
    hypothesis: "Momentum hypothesis",
    benchmark: "Equal weighted",
    stoppingRule: "At registered budget",
    development: {
      datasetSnapshotId: snapshotId,
      symbols: ["AAA", "BBB", "CCC"],
      startDate: "2025-01-01",
      endDate: "2025-03-01",
    },
    evaluation: { method: "factor_rank_ic_v1", horizonDays: 1, groupCount: 3 },
    budget: { maxAttempts: 10, maxEvaluations: 2 },
  };
}
async function setup() {
  const projectId = randomUUID();
  (await getDb())
    .insert(project)
    .values({ id: projectId, workspaceId, name: "Controlled research", marketScope: "US" })
    .run();
  const protocol = await researchRunner.createProtocol({ projectId, spec: spec() });
  const factor = await factorService.register({
    projectId,
    category: "momentum",
    name: `mom_${randomUUID()}`,
    expr: "close / Ref(close, 2) - 1",
    lang: "qlib_expr",
    providerKey: "qlib_expr",
    universe: "US",
    dryRun: false,
  });
  return { projectId, protocol, factor };
}
describe("research runner and operator routes", () => {
  test("an unavailable configured catalog cannot be bypassed by omitting sealedDatasetId", async () => {
    const { projectId } = await setup();
    const client = new SealedEvaluatorClient({
      url: "https://unavailable-evaluator.test",
      token: "test-token",
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const runner = new ResearchRunner(client);
    await expect(runner.createProtocol({ projectId, spec: spec() })).rejects.toThrow(
      "sealed_evaluator_unavailable"
    );
    expect((await researchProgramService.get(projectId)).protocols).toHaveLength(1);
  });
  test("async submission persists before execution, retries once, records bound snapshot and evidence", async () => {
    const { projectId, factor } = await setup();
    const body = { factorId: factor.id, kind: "factor_compute", idempotencyKey: randomUUID() };
    const send = () =>
      researchProgramRouter.request(`/${projectId}/attempts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const [first, second] = await Promise.all([send(), send()]);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const a = (await first.json()) as { data: { id: string } };
    const b = (await second.json()) as { data: { id: string } };
    expect(a.data.id).toBe(b.data.id);
    const terminal = await researchRunner.waitForAttempt(a.data.id);
    expect(terminal.status).toBe("completed");
    expect(
      (
        terminal.resultJson as {
          meta: { datasetSnapshotId: string; dataIntegrity: { status: string } };
        }
      ).meta.datasetSnapshotId
    ).toBe(snapshotId);
    expect(
      (
        terminal.resultJson as {
          meta: { datasetSnapshotId: string; dataIntegrity: { status: string } };
        }
      ).meta.dataIntegrity.status
    ).toBe("research_only");
    expect((await researchProgramService.get(projectId)).program?.usedAttempts).toBe(1);
  });
  test("development evaluation invokes nested compute but consumes only one experiment", async () => {
    const { projectId, factor } = await setup();
    const attempt = await researchRunner.submitFactor({
      projectId,
      factorId: factor.id,
      kind: "factor_evaluate",
      idempotencyKey: randomUUID(),
    });
    const terminal = await researchRunner.waitForAttempt(attempt.id);
    expect(terminal.status).toBe("completed");
    expect((await researchProgramService.get(projectId)).attempts).toHaveLength(1);
    expect((terminal.resultJson as { evaluationId: string }).evaluationId).toBeTruthy();
  });
  test("direct old compute endpoint cannot change context and failed attempts remain charged", async () => {
    const { projectId, factor } = await setup();
    await expect(
      factorService.compute({
        factorId: factor.id,
        startDate: "2025-02-01",
        endDate: "2025-03-01",
        persist: false,
      })
    ).rejects.toThrow("context_mismatch:startDate");
    const detail = await researchProgramService.get(projectId);
    expect(detail.attempts[0]?.status).toBe("failed");
    expect(detail.program?.usedAttempts).toBe(1);
  });
  test("future expression fails after registration, without writing a success", async () => {
    const { projectId } = await setup();
    const factor = await factorService.register({
      projectId,
      category: "momentum",
      name: `future_${randomUUID()}`,
      expr: "Ref(close, -1)",
      lang: "qlib_expr",
      providerKey: "qlib_expr",
      dryRun: false,
    });
    const attempt = await researchRunner.submitFactor({
      projectId,
      factorId: factor.id,
      kind: "factor_compute",
      idempotencyKey: randomUUID(),
    });
    expect((await researchRunner.waitForAttempt(attempt.id)).status).toBe("failed");
    expect((await researchProgramService.get(projectId)).program?.usedAttempts).toBe(1);
  });
  test("operator API rejects injected fields and cross-project cancellation", async () => {
    const a = await setup();
    const b = await setup();
    const response = await researchProgramRouter.request(`/${a.projectId}/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        factorId: a.factor.id,
        kind: "factor_compute",
        idempotencyKey: "test",
        projectId: b.projectId,
      }),
    });
    expect(response.status).toBe(400);
    const attempt = await researchProgramService.reserve({
      projectId: a.projectId,
      kind: "factor_compute",
      candidateId: a.factor.id,
      candidateJson: {},
      requestJson: {},
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await researchProgramRouter.request(`/${b.projectId}/attempts/${attempt.id}/cancel`, {
          method: "POST",
        })
      ).status
    ).toBe(404);
    expect((await researchProgramService.getAttempt(attempt.id)).status).toBe("pending");
    await researchRunner.cancel(a.projectId, attempt.id);
  });
  test("cancelled work cannot overwrite a terminal ledger with late success", async () => {
    const { projectId, factor } = await setup();
    const attempt = await researchProgramService.reserve({
      projectId,
      kind: "factor_compute",
      candidateId: factor.id,
      candidateJson: {},
      requestJson: {},
      idempotencyKey: randomUUID(),
    });
    let release!: (value: { rows: number[] }) => void;
    const delayed = new Promise<{ rows: number[] }>((resolve) => {
      release = resolve;
    });
    const result = executeResearchAttempt(attempt, () => delayed).catch((error) => error);
    await Bun.sleep(10);
    await researchRunner.cancel(projectId, attempt.id);
    release({ rows: [1] });
    expect(await result).toBeInstanceOf(Error);
    const stored = await researchProgramService.getAttempt(attempt.id);
    expect(stored.status).toBe("cancelled");
    expect(stored.resultJson).toBeNull();
  });
  test("no sealed service returns unavailable and never fabricates a formal receipt", async () => {
    const { projectId, factor } = await setup();
    await expect(
      researchRunner.submitFactor({
        projectId,
        factorId: factor.id,
        kind: "sealed_factor",
        idempotencyKey: randomUUID(),
      })
    ).rejects.toThrow("sealed_dataset_not_configured");
    expect((await researchProgramService.get(projectId)).attempts).toHaveLength(0);
  });
  test("registered factor travels through the independent service and keeps an insufficient-evidence receipt", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = {
      version: "sealed-factor-dataset-v1",
      id: "runner-sealed-fixture",
      label: "Synthetic test only",
      maxEvaluations: 2,
      horizonDays: 1,
      groupCount: 3,
      dataset: {
        snapshotId: "synthetic-sealed",
        dataRef: "isolated-fixture",
        asOf: "2026-06-01T00:00:00Z",
        timeframe: "1d",
        sourceIds: ["synthetic-test-only"],
        qualification: {
          useClass: "research_only",
          pointInTime: "not_verified",
          universeHistory: "not_verified",
          corporateActions: "raw_unadjusted",
          limitations: ["synthetic_test_only"],
        },
        barsBySymbol: Object.fromEntries(
          ["AAA", "BBB", "CCC"].map((symbol, offset) => [
            symbol,
            Array.from({ length: 80 }, (_, i) => ({
              timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
              open: 100 + i + offset,
              close: 100 + i + offset,
              high: 101 + i + offset,
              low: 99 + i + offset,
              volume: 100,
              turnover: (100 + i + offset) * 100,
            })),
          ])
        ),
      },
    };
    const evaluator = createSealedEvaluator({
      sqliteFilename: ":memory:",
      token: "synthetic-test-secret",
      trustedPublicKeys: { fixture: String(publicKey.export({ type: "spki", format: "pem" })) },
      bundles: [
        {
          keyId: "fixture",
          payload,
          signature: sign(null, Buffer.from(canonicalSealedJson(payload)), privateKey).toString(
            "base64"
          ),
        },
      ],
    });
    const client = new SealedEvaluatorClient({
      url: "https://isolated-evaluator.test",
      token: "synthetic-test-secret",
      fetch: (async (url: string, options: RequestInit) =>
        evaluator.fetch(new Request(url, options))) as typeof fetch,
    });
    const runner = new ResearchRunner(client);
    try {
      const { projectId, factor } = await setup();
      const development = spec();
      await runner.createProtocol({
        projectId,
        spec: {
          ...development,
          evaluation: { ...development.evaluation, sealedDatasetId: payload.id },
        },
      });
      const attempt = await runner.submitFactor({
        projectId,
        factorId: factor.id,
        kind: "sealed_factor",
        idempotencyKey: randomUUID(),
      });
      const result = await runner.waitForAttempt(attempt.id);
      expect(result.status).toBe("completed");
      expect(result.resultJson).toMatchObject({
        version: "sealed-factor-v1",
        status: "insufficient_evidence",
        attemptId: attempt.id,
      });
      expect(JSON.stringify(result.resultJson)).not.toContain("barsBySymbol");
      expect((await researchProgramService.get(projectId)).program?.usedEvaluations).toBe(1);
    } finally {
      evaluator.close();
    }
  });
});
