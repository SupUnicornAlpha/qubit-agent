import { beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { getDb } from "../../../db/sqlite/client";
import { runMigrations } from "../../../db/sqlite/migrate";
import { project, workspace } from "../../../db/sqlite/schema";
import { factorRouter } from "../../../routes/factor.routes";
import { defaultDataDir } from "../../app-paths";
import { buildMarketSnapshotRecord } from "../../market/contracts/market-snapshot-service";
import { _resetBootstrapForTests, bootstrapProviders } from "../../provider/bootstrap";
import { factorService } from "../factor-service";

const app = new Hono().route("/factors", factorRouter);
const symbols = ["AAA", "BBB", "CCC", "DDD", "EEE"];
let projectId = "";
let snapshotId = "";
let causalFactorId = "";
let futureFactorId = "";

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function responseData<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { ok: boolean; data: T };
  expect(payload.ok).toBe(true);
  return payload.data;
}

function context() {
  return {
    datasetSnapshotId: snapshotId,
    symbols,
    startDate: "2026-01-01",
    endDate: "2026-03-01",
  };
}

beforeAll(async () => {
  await runMigrations();
  _resetBootstrapForTests();
  await bootstrapProviders();
  const db = await getDb();
  const workspaceId = randomUUID();
  projectId = randomUUID();
  await db.insert(workspace).values({ id: workspaceId, name: "integrity-test", owner: "test" });
  await db.insert(project).values({
    id: projectId,
    workspaceId,
    name: "integrity-test",
    marketScope: "US",
    status: "active",
  });
  const record = buildMarketSnapshotRecord({
    asOf: "2026-03-31T23:59:59.999Z",
    purpose: "research",
    instruments: symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" })),
    window: { start: "2026-01-01", end: "2026-03-31" },
    sources: [
      { provider: `local-fixture-${randomUUID()}`, feed: "fixture", upstreamFamily: "fixture" },
    ],
    barsByInstrument: Object.fromEntries(
      symbols.map((symbol, symbolIndex) => [
        `US:${symbol}`,
        Array.from({ length: 90 }, (_, index) => {
          const timestamp = new Date(Date.UTC(2026, 0, 1 + index)).toISOString();
          const close = 50 + symbolIndex * 20 + index * (symbolIndex + 1) + Math.sin(index / 3);
          return {
            timestamp,
            open: close - 0.2,
            high: close + 1,
            low: close - 1,
            close,
            volume: 1_000,
            turnover: close * 1_000,
          };
        }),
      ])
    ),
    timeframe: "1d",
    limit: 90,
  });
  snapshotId = record.snapshot.snapshotId;
  const root = join(defaultDataDir(), "market-snapshots");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${snapshotId}.json`), JSON.stringify(record), "utf8");
  causalFactorId = (
    await factorService.register({
      projectId,
      name: `causal-${randomUUID()}`,
      category: "momentum",
      lang: "qlib_expr",
      expr: "close / Ref(close, 1) - 1",
      universe: "US",
      horizon: 1,
      dryRun: false,
    })
  ).id;
  futureFactorId = (
    await factorService.register({
      projectId,
      name: `future-${randomUUID()}`,
      category: "momentum",
      lang: "qlib_expr",
      expr: "Ref(close, -1)",
      universe: "US",
      horizon: 1,
      dryRun: false,
    })
  ).id;
});

describe("frozen factor data integrity service and API", () => {
  test("inspection is read-only and retains source uncertainty after a causal expression passes", async () => {
    const response = await post(`/factors/${causalFactorId}/data-integrity`, context());
    expect(response.status).toBe(200);
    const data =
      await responseData<Awaited<ReturnType<typeof factorService.checkDataIntegrity>>>(response);
    expect(data).toMatchObject({
      version: "factor-data-integrity-v1",
      factorId: causalFactorId,
      datasetSnapshotId: snapshotId,
      status: "research_only",
      qualification: { pointInTime: "not_verified", useClass: "research_only" },
      truncation: { status: "passed", mismatchCount: 0 },
    });
    expect(data.expressionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data.truncation?.uniqueComparedValues).toBeGreaterThan(10);
    expect(
      await factorService.loadValues({ factorId: causalFactorId, datasetSnapshotId: snapshotId })
    ).toEqual([]);
    expect(await factorService.listEvaluations(causalFactorId)).toEqual([]);
  });

  test("API rejects invalid context and returns failed evidence for an explicit future reference", async () => {
    const malformed = await post(`/factors/${causalFactorId}/data-integrity`, {
      ...context(),
      startDate: "2026-02-30",
    });
    expect(malformed.status).toBe(400);
    const extra = await post(`/factors/${causalFactorId}/data-integrity`, {
      ...context(),
      providerKey: "qlib_expr",
    });
    expect(extra.status).toBe(400);
    const response = await post(`/factors/${futureFactorId}/data-integrity`, context());
    expect(response.status).toBe(200);
    const data =
      await responseData<Awaited<ReturnType<typeof factorService.checkDataIntegrity>>>(response);
    expect(data.status).toBe("failed");
    expect(data.truncation?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "future_reference" })])
    );
  });

  test("compute rejects look-ahead before writing either frozen or unversioned values", async () => {
    const response = await post(`/factors/${futureFactorId}/compute`, context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "factor_data_integrity_failed",
    });
    expect(
      await factorService.loadValues({ factorId: futureFactorId, datasetSnapshotId: snapshotId })
    ).toEqual([]);
    expect(await factorService.loadValues({ factorId: futureFactorId })).toEqual([]);
    expect(await factorService.listEvaluations(futureFactorId)).toEqual([]);
  });

  test("compute persists causal values only under their frozen snapshot", async () => {
    const response = await post(`/factors/${causalFactorId}/compute`, context());
    expect(response.status).toBe(200);
    const data = await responseData<Awaited<ReturnType<typeof factorService.compute>>>(response);
    expect(data.meta.dataIntegrity).toMatchObject({
      status: "research_only",
      datasetSnapshotId: snapshotId,
    });
    expect(data.rows.length).toBeGreaterThan(100);
    const values = await factorService.loadValues({
      factorId: causalFactorId,
      datasetSnapshotId: snapshotId,
    });
    expect(values).toHaveLength(data.rows.length);
    for (const [index, row] of values.entries()) {
      const expected = data.rows[index];
      if (!expected) throw new Error(`missing expected row at ${index}`);
      expect({ symbol: row.symbol, date: row.date }).toEqual({
        symbol: expected.symbol,
        date: expected.date,
      });
      if (expected.value === null) expect(row.value).toBeNull();
      else expect(row.value).toBeCloseTo(expected.value, 12);
    }
    expect(await factorService.loadValues({ factorId: causalFactorId })).toEqual([]);
  });

  test("auto-evaluation persists matching integrity evidence and cannot turn an unknown source into validation", async () => {
    const response = await post(`/factors/${causalFactorId}/auto-evaluate`, {
      ...context(),
      horizonDays: 1,
      decayHorizons: [1],
      groupCount: 3,
    });
    expect(response.status).toBe(200);
    const data =
      await responseData<Awaited<ReturnType<typeof factorService.autoEvaluate>>>(response);
    expect(data.statisticalReport).toMatchObject({
      status: "research_only",
      dataIntegrity: {
        factorId: causalFactorId,
        datasetSnapshotId: snapshotId,
        status: "research_only",
      },
    });
    const evaluations = await factorService.listEvaluations(causalFactorId);
    const persisted = evaluations.find((row) => row.id === data.evaluationId);
    expect(persisted?.datasetSnapshotId).toBe(snapshotId);
    expect(persisted?.statisticalReportJson).toEqual(data.statisticalReport);
    expect((await factorService.assessStrategyEligibility([causalFactorId]))[0]?.eligible).toBe(
      false
    );
  });
});
