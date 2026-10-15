import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "../../db/sqlite/client";
import { runMigrations } from "../../db/sqlite/migrate";
import { project, workspace } from "../../db/sqlite/schema";
import { bindBacktestDataset } from "../backtest/dataset-snapshot-binding";
import { sealedEvaluatorClient } from "./evaluator-client";
import { publicDataRequestSchema } from "./public-data-contract";
import {
  assertPublicDevelopmentWindow,
  fetchPublicDaily,
  listPublicDataImports,
  parseYahooDaily,
  publicSnapshot,
  submitPublicDataImport,
  yahooDailyUrl,
} from "./public-market-data";
import { persistRecord } from "../market/contracts/market-snapshot-service";
const dirs: string[] = [];
const wid = randomUUID();
const pid = randomUUID();
beforeAll(async () => {
  await runMigrations();
  const db = await getDb();
  db.insert(workspace).values({ id: wid, name: "public-data-test", owner: "test" }).run();
  db.insert(project).values({ id: pid, workspaceId: wid, name: "public", marketScope: "US" }).run();
});
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const input = {
  provider: "yahoo_chart" as const,
  symbols: ["AAA", "BBB", "CCC"],
  startDate: "2020-01-01",
  endDate: "2020-04-30",
  idempotencyKey: "fixture",
};
function fixture(symbol = "AAA") {
  return {
    chart: {
      error: null,
      result: [
        {
          meta: { symbol, currency: "USD", instrumentType: "ETF", exchangeName: "PCX" },
          timestamp: Array.from({ length: 80 }, (_, i) => Date.UTC(2020, 0, 1 + i, 14, 30) / 1000),
          indicators: {
            quote: [
              {
                open: Array(80).fill(10),
                high: Array(80).fill(12),
                low: Array(80).fill(9),
                close: Array(80).fill(11),
                volume: Array(80).fill(100),
              },
            ],
            adjclose: [{ adjclose: Array(80).fill(5) }],
          },
        },
      ],
    },
  };
}
test("requires a bounded US request and cannot inject URL, PIT status, future or invalid dates", () => {
  expect(publicDataRequestSchema.parse(input).symbols).toHaveLength(3);
  for (const extra of [
    { url: "http://localhost/private" },
    { pointInTime: "verified" },
    { endDate: "2099-01-01" },
    { startDate: "2020-02-30" },
    { symbols: ["AAA", "AAA", "CCC"] },
    { startDate: "2001-01-01" },
  ])
    expect(publicDataRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
  expect(new URL(yahooDailyUrl("AAA", input.startDate, input.endDate)).hostname).toBe(
    "query1.finance.yahoo.com"
  );
});
test("uses consistent OHLC, delays availability to session end and rejects invalid rows instead of dropping them", () => {
  const value = fixture();
  const bars = parseYahooDaily(JSON.stringify(value), "AAA", input.startDate, input.endDate);
  expect(bars[0]?.close).toBe(11);
  expect(bars[0]?.timestamp).toBe("2020-01-01T23:59:59.000Z");
  expect(bars[0]?.turnover).toBe(0);
  for (const mutate of [
    (v: any) => {
      v.chart.result[0].timestamp[1] = v.chart.result[0].timestamp[0];
    },
    (v: any) => {
      v.chart.result[0].indicators.quote[0].close[2] = null;
    },
    (v: any) => {
      v.chart.result[0].indicators.quote[0].high[2] = 8;
    },
    (v: any) => {
      v.chart.result[0].meta.currency = "CNY";
    },
    (v: any) => {
      v.chart.result[0].meta.exchangeName = "LSE";
    },
    (v: any) => {
      v.chart.result[0].meta.symbol = "OTHER";
    },
    (v: any) => v.chart.result[0].timestamp.push(1),
  ]) {
    const changed = structuredClone(value);
    mutate(changed);
    expect(() =>
      parseYahooDaily(JSON.stringify(changed), "AAA", input.startDate, input.endDate)
    ).toThrow();
  }
});
test("retains raw response checksums and immutable snapshots stay research-only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qubit-public-unit-"));
  dirs.push(dir);
  const result = await fetchPublicDaily(input, {
    rawDir: dir,
    fetch: (async (url: any) =>
      Response.json(fixture(new URL(String(url)).pathname.split("/").at(-1)))) as typeof fetch,
  });
  expect(result.provenance).toHaveLength(3);
  for (const p of result.provenance)
    expect(
      createHash("sha256")
        .update(await readFile(join(dir, `${p.sha256}.json`)))
        .digest("hex")
    ).toBe(p.sha256);
  const record = await persistRecord(publicSnapshot(input, result.barsByInstrument));
  const dataset = await bindBacktestDataset({
    snapshotId: record.snapshot.snapshotId,
    symbols: input.symbols,
    startDate: input.startDate,
    endDate: input.endDate,
    timeframe: "1d",
  });
  expect(dataset?.qualification?.useClass).toBe("research_only");
  expect(dataset?.qualification?.pointInTime).toBe("not_verified");
  const first = result.provenance[0];
  if (!first) throw new Error("missing_test_provenance");
  await writeFile(join(dir, `${first.sha256}.json`), "tampered");
  await expect(
    fetchPublicDaily(input, {
      rawDir: dir,
      fetch: (async (url: Parameters<typeof fetch>[0]) =>
        Response.json(fixture(new URL(String(url)).pathname.split("/").at(-1)))) as typeof fetch,
    })
  ).rejects.toThrow("public_data_raw_integrity_failed");
});
test("fails closed when evaluator is unavailable or a sealed period overlaps", async () => {
  const catalog = spyOn(sealedEvaluatorClient, "catalog");
  try {
    catalog.mockResolvedValue({
      configured: false,
      datasets: [],
      reason: "sealed_evaluator_unavailable",
    });
    await expect(assertPublicDevelopmentWindow(input)).rejects.toThrow(
      "sealed_evaluator_unavailable"
    );
    catalog.mockResolvedValue({
      configured: true,
      datasets: [
        {
          id: "sealed",
          label: "sealed",
          startDate: "2020-03-01",
          endDate: "2020-12-31",
          maxEvaluations: 1,
          horizonDays: 1,
          groupCount: 3,
          datasetFingerprint: `sha256:${"a".repeat(64)}`,
        },
      ],
    });
    await expect(assertPublicDevelopmentWindow(input)).rejects.toThrow("overlaps_sealed");
    await expect(
      assertPublicDevelopmentWindow({ startDate: "2019-01-01", endDate: "2019-12-31" })
    ).resolves.toBeUndefined();
  } finally {
    catalog.mockRestore();
  }
});
test("concurrent retries download once, project scope is fixed, failed imports remain recorded", async () => {
  const original = globalThis.fetch;
  const catalog = spyOn(sealedEvaluatorClient, "catalog").mockResolvedValue({
    configured: false,
    datasets: [],
    reason: "sealed_evaluator_not_configured",
  });
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response("rate limited", { status: 429 });
  }) as unknown as typeof fetch;
  try {
    const request = { ...input, idempotencyKey: randomUUID() };
    const jobs = await Promise.all([
      submitPublicDataImport(pid, request),
      submitPublicDataImport(pid, request),
    ]);
    expect(jobs[0]?.id).toBe(jobs[1]?.id);
    let job: Awaited<ReturnType<typeof listPublicDataImports>>[number] | undefined;
    for (let i = 0; i < 50; i++) {
      job = (await listPublicDataImports(pid)).find((j) => j.id === jobs[0]?.id);
      if (job?.status !== "running") break;
      await Bun.sleep(10);
    }
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("429");
    expect(calls).toBe(1);
    expect(await listPublicDataImports("other-project")).toHaveLength(0);
    await expect(
      submitPublicDataImport(pid, { ...request, endDate: "2020-03-31" })
    ).rejects.toThrow("idempotency_conflict");
    await expect(submitPublicDataImport("missing-project", request)).rejects.toThrow(
      "project_not_found"
    );
    await submitPublicDataImport(pid, request);
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = original;
    catalog.mockRestore();
  }
});
