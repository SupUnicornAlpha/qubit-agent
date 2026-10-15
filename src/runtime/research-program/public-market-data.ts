/** Fixed-origin public US daily import. Vendor history is never a PIT attestation. */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { project } from "../../db/sqlite/schema";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { defaultDataDir } from "../app-paths";
import {
  buildMarketSnapshotRecord,
  persistRecord,
  type SnapshotBar,
} from "../market/contracts/market-snapshot-service";
import { sealedEvaluatorClient } from "./evaluator-client";

import {
  publicDataRequestSchema,
  PUBLIC_DATA_LIMITATIONS,
  type PublicDataRequest,
  type PublicDataImport,
} from "./public-data-contract";
export { publicDataRequestSchema } from "./public-data-contract";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function yahooDailyUrl(symbol: string, startDate: string, endDate: string) {
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
  );
  url.search = new URLSearchParams({
    period1: String(Date.parse(startDate) / 1000),
    period2: String(Date.parse(endDate) / 1000 + 86400),
    interval: "1d",
    events: "div,splits",
  }).toString();
  return url.toString();
}
export function parseYahooDaily(
  raw: string,
  symbol: string,
  startDate: string,
  endDate: string
): SnapshotBar[] {
  const data = JSON.parse(raw);
  const result = data.chart?.result?.[0];
  if (
    data.chart?.error ||
    !result ||
    result.meta?.symbol !== symbol ||
    result.meta?.currency !== "USD" ||
    !["EQUITY", "ETF"].includes(result.meta?.instrumentType) ||
    !["NYQ", "PCX", "NMS", "NGM", "NCM", "ASE", "BTS"].includes(result.meta?.exchangeName)
  )
    throw new Error(`public_data_identity_invalid:${symbol}`);
  const timestamps: unknown[] = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (
    !Array.isArray(timestamps) ||
    !q ||
    timestamps.length > 2000 ||
    ["open", "high", "low", "close", "volume"].some(
      (k) => !Array.isArray(q[k]) || q[k].length !== timestamps.length
    )
  )
    throw new Error(`public_data_shape_invalid:${symbol}`);
  let previous = "";
  const bars = timestamps.map((time, index) => {
    if (typeof time !== "number" || !Number.isFinite(time))
      throw new Error("public_data_timestamp_invalid");
    const date = new Date(time * 1000).toISOString().slice(0, 10);
    const [open, high, low, close, volume] = [
      q.open[index],
      q.high[index],
      q.low[index],
      q.close[index],
      q.volume[index],
    ];
    if (
      date < startDate ||
      date > endDate ||
      date <= previous ||
      ![open, high, low, close, volume].every((v) => typeof v === "number" && Number.isFinite(v)) ||
      low <= 0 ||
      volume < 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close)
    )
      throw new Error(`public_data_bar_invalid:${symbol}:${date}`);
    previous = date;
    // Vendor timestamps label session OPEN. OHLC is only available after the session ends.
    return { timestamp: `${date}T23:59:59.000Z`, open, high, low, close, volume, turnover: 0 };
  });
  if (bars.length < 60) throw new Error(`public_data_insufficient_history:${symbol}`);
  return bars;
}
export async function fetchPublicDaily(
  input: Pick<PublicDataRequest, "symbols" | "startDate" | "endDate">,
  options: { fetch?: typeof fetch; rawDir: string }
) {
  const barsByInstrument: Record<string, SnapshotBar[]> = {};
  const provenance: PublicDataImport["provenance"] = [];
  await mkdir(options.rawDir, { recursive: true, mode: 0o700 });
  // Bounded sequential requests avoid amplifying public endpoint throttling.
  for (const symbol of input.symbols) {
    const url = yahooDailyUrl(symbol, input.startDate, input.endDate);
    const response = await (options.fetch ?? fetch)(url, {
      headers: { "User-Agent": "Mozilla/5.0 QubitResearch/1.0" },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`public_data_http_${response.status}:${symbol}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("public_data_empty_response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2_000_000) throw new Error("public_data_response_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const bars = parseYahooDaily(raw, symbol, input.startDate, input.endDate);
    const sha256 = digest(raw);
    await writeFile(join(options.rawDir, `${sha256}.json`), raw, { flag: "wx", mode: 0o600 }).catch(
      async (error) => {
        if (error.code !== "EEXIST") throw error;
        if (digest(await readFile(join(options.rawDir, `${sha256}.json`), "utf8")) !== sha256)
          throw new Error("public_data_raw_integrity_failed");
      }
    );
    barsByInstrument[`US:${symbol}`] = bars;
    provenance.push({
      symbol,
      url,
      retrievedAt: new Date().toISOString(),
      sha256,
      rows: bars.length,
    });
  }
  return { barsByInstrument, provenance };
}
export function publicSnapshot(
  input: Pick<PublicDataRequest, "symbols" | "startDate" | "endDate">,
  barsByInstrument: Record<string, SnapshotBar[]>,
  asOf = new Date().toISOString()
) {
  return buildMarketSnapshotRecord({
    purpose: "research",
    asOf,
    instruments: input.symbols.map((symbol) => ({ symbol, venue: "US", assetClass: "equity" })),
    window: { start: input.startDate, end: input.endDate },
    timeframe: "1d",
    limit: 2000,
    sources: [
      {
        provider: "yahoo_chart",
        feed: "public_aggregate",
        upstreamFamily: "yahoo",
        feedClass: "L0_research_fallback",
        licenseUse: "research_only",
      },
    ],
    adjustMethod: "vendor_ohlc_no_adjclose",
    timezone: "America/New_York",
    barsByInstrument,
  });
}
export async function assertPublicDevelopmentWindow(input: { startDate: string; endDate: string }) {
  const catalog = await sealedEvaluatorClient.catalog();
  if (!catalog.configured && catalog.reason !== "sealed_evaluator_not_configured")
    throw new Error("sealed_evaluator_unavailable");
  if (catalog.datasets.some((d) => input.startDate <= d.endDate && input.endDate >= d.startDate))
    throw new Error("research_development_overlaps_sealed_data");
}
const active = new Set<string>();
const root = () => join(defaultDataDir(), "research-data-imports");
const pathFor = (id: string) => join(root(), `${id}.json`);
async function save(job: PublicDataImport) {
  const path = pathFor(job.id);
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(job, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
export async function listPublicDataImports(projectId: string): Promise<PublicDataImport[]> {
  await mkdir(root(), { recursive: true });
  const entries = await readdir(root());
  const jobs: PublicDataImport[] = [];
  for (const entry of entries.filter((e) => /^[a-f0-9]{64}\.json$/.test(e))) {
    const job = JSON.parse(await readFile(join(root(), entry), "utf8")) as PublicDataImport;
    if (job.projectId !== projectId) continue;
    if (
      job.status === "running" &&
      !active.has(job.id) &&
      Date.now() - Date.parse(job.createdAt) > 10 * 60_000
    ) {
      job.status = "failed";
      job.error = "import_interrupted_restart_with_new_key";
      job.endedAt = new Date().toISOString();
      await save(job);
    }
    jobs.push(job);
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
const submissions = new Map<string, Promise<PublicDataImport>>();
export async function submitPublicDataImport(projectId: string, raw: unknown) {
  const request = publicDataRequestSchema.parse(raw);
  const id = digest(`${projectId}:${request.idempotencyKey}`);
  const prior = submissions.get(id);
  if (prior) {
    const job = await prior;
    if (JSON.stringify(job.request) !== JSON.stringify(request))
      throw new Error("public_data_idempotency_conflict");
    return structuredClone(job);
  }
  const work = submitImport(projectId, request);
  submissions.set(id, work);
  try {
    return await work;
  } finally {
    submissions.delete(id);
  }
}
async function submitImport(projectId: string, raw: unknown): Promise<PublicDataImport> {
  const request = publicDataRequestSchema.parse(raw);
  if (
    !(await getDb()).select({ id: project.id }).from(project).where(eq(project.id, projectId)).get()
  )
    throw new Error("research_project_not_found");
  const id = digest(`${projectId}:${request.idempotencyKey}`);
  await mkdir(root(), { recursive: true });
  try {
    const old = JSON.parse(await readFile(pathFor(id), "utf8")) as PublicDataImport;
    if (JSON.stringify(old.request) !== JSON.stringify(request))
      throw new Error("public_data_idempotency_conflict");
    return old;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await assertPublicDevelopmentWindow(request);
  if (active.size >= 2) throw new Error("public_data_import_busy");
  const job: PublicDataImport = {
    id,
    projectId,
    request,
    status: "running",
    createdAt: new Date().toISOString(),
    provenance: [],
    qualification: "research_only",
    limitations: PUBLIC_DATA_LIMITATIONS,
  };
  // Publish a complete file atomically; retries never see partially written JSON.
  active.add(id);
  const temporary = join(root(), `${id}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(job), { flag: "wx", mode: 0o600 });
    await link(temporary, pathFor(id));
  } catch (error) {
    active.delete(id);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = JSON.parse(await readFile(pathFor(id), "utf8")) as PublicDataImport;
      if (JSON.stringify(existing.request) !== JSON.stringify(request))
        throw new Error("public_data_idempotency_conflict");
      return existing;
    }
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  void (async () => {
    try {
      const data = await fetchPublicDaily(request, { rawDir: join(root(), "raw") });
      job.provenance = data.provenance;
      await assertPublicDevelopmentWindow(request);
      const record = await persistRecord(publicSnapshot(request, data.barsByInstrument));
      job.snapshotId = record.snapshot.snapshotId;
      job.barCounts = record.meta.barCounts;
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.endedAt = new Date().toISOString();
      try {
        await save(job);
      } finally {
        active.delete(id);
      }
    }
  })().catch(() =>
    console.error("[PublicData] Could not persist import outcome; task will expire as interrupted.")
  );
  return structuredClone(job);
}
