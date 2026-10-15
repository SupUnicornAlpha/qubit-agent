/** Operator provisioning only. Never exposed to research tools: downloads and signs the sealed bundle. */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  fetchPublicDaily,
  publicSnapshot,
} from "../src/runtime/research-program/public-market-data";
import { PUBLIC_DATA_LIMITATIONS } from "../src/runtime/research-program/public-data-contract";
import { persistRecord } from "../src/runtime/market/contracts/market-snapshot-service";
import {
  canonicalSealedJson,
  signedSealedDatasetBundleSchema,
} from "../src/runtime/research-program/sealed-evaluator";
const researchDir = process.env.QUBIT_DATA_DIR;
const evaluatorDir = process.env.QUBIT_EVALUATOR_DIR;
if (
  !researchDir ||
  !evaluatorDir ||
  !isAbsolute(researchDir) ||
  !isAbsolute(evaluatorDir) ||
  !(
    relative(researchDir, evaluatorDir) === ".." ||
    relative(researchDir, evaluatorDir).startsWith(`..${sep}`)
  )
)
  throw new Error(
    "Set absolute, separate QUBIT_DATA_DIR and QUBIT_EVALUATOR_DIR (outside research storage)"
  );
const manifestPath = join(researchDir, "public-research-manifest.json");
if (existsSync(manifestPath)) {
  console.log(await readFile(manifestPath, "utf8"));
  process.exit(0);
}
// Never replace an existing evaluator's trust configuration or erase its quota.
if (existsSync(join(evaluatorDir, "config.json")))
  throw new Error("existing_evaluator_config_requires_operator_review");
await mkdir(evaluatorDir, { recursive: true, mode: 0o700 });
await mkdir(researchDir, { recursive: true, mode: 0o700 });
const symbols = ["XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY"];
const development = { symbols, startDate: "2020-01-01", endDate: "2023-12-31" };
const holdout = { symbols, startDate: "2024-01-01", endDate: "2024-12-31" };
// Declared before fetching or computing any results; no search based on the holdout.
const design = {
  market: "US",
  frequency: "1d",
  development,
  holdout,
  limitations: PUBLIC_DATA_LIMITATIONS,
  benchmark: "close/Ref(close,20)-1",
  horizonDays: 5,
  groupCount: 3,
  costBps: 10,
  candidateWeight: 0.25,
  candidates: [
    { name: "1日反转", expr: "Ref(close,1)/close-1" },
    { name: "5日反转", expr: "Ref(close,5)/close-1" },
    { name: "20日反转", expr: "Ref(close,20)/close-1" },
    { name: "60日动量", expr: "close/Ref(close,60)-1" },
    { name: "120日动量", expr: "close/Ref(close,120)-1" },
    { name: "20日低波动", expr: "-Std(close/Ref(close,1)-1,20)" },
  ],
  budget: { maxAttempts: 30, maxEvaluations: 2 },
  execution: {
    capital: 100000,
    topN: 3,
    rebalance: "weekly",
    commissionBps: 5,
    slippageBps: 5,
    minCommission: 1,
    maxVolumeParticipation: 0.05,
  },
  strategyPolicy: {
    method: "us_daily_top_n_v1",
    benchmark: "equal_weight_daily",
    minObservations: 120,
    minTrades: 5,
    minExcessReturn: 0,
    maxDrawdown: 0.25,
  },
};
const designPath = join(researchDir, "public-research-design.json");
if (existsSync(designPath)) {
  if (JSON.stringify(JSON.parse(await readFile(designPath, "utf8"))) !== JSON.stringify(design))
    throw new Error("predeclared_design_changed");
} else await writeFile(designPath, JSON.stringify(design, null, 2), { flag: "wx", mode: 0o600 });
const dev = await fetchPublicDaily(development, {
  rawDir: join(researchDir, "research-data-imports", "raw"),
});
const record = await persistRecord(publicSnapshot(development, dev.barsByInstrument), researchDir);
console.log(`Development snapshot ready: ${record.snapshot.snapshotId}`);
const sealed = await fetchPublicDaily(holdout, { rawDir: join(evaluatorDir, "raw") });
const sealedRecord = publicSnapshot(holdout, sealed.barsByInstrument);
const payload = {
  allowResearchDiagnostics: true,
  version: "sealed-factor-dataset-v1",
  id: "us-sector-etf-2024-public-v1",
  label: "US 行业 ETF · 2024 封存研究（时点证据不足）",
  maxEvaluations: 2,
  horizonDays: 5,
  groupCount: 3,
  strategyPolicy: design.strategyPolicy,
  dataset: {
    snapshotId: sealedRecord.snapshot.snapshotId,
    dataRef: sealedRecord.dataRef,
    asOf: sealedRecord.snapshot.asOf,
    timeframe: "1d",
    sourceIds: ["yahoo_chart"],
    barsBySymbol: Object.fromEntries(
      Object.entries(sealed.barsByInstrument).map(([k, v]) => [k.slice(3), v])
    ),
    qualification: {
      useClass: "research_only",
      universeHistory: "not_verified",
      corporateActions: "not_verified",
      pointInTime: "not_verified",
      limitations: PUBLIC_DATA_LIMITATIONS,
    },
  },
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const bundle = signedSealedDatasetBundleSchema.parse({
  keyId: "local-public-import",
  payload,
  signature: sign(null, Buffer.from(canonicalSealedJson(payload)), privateKey).toString("base64"),
});
await writeFile(join(evaluatorDir, "public-2024.bundle.json"), JSON.stringify(bundle), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(join(evaluatorDir, "provenance.json"), JSON.stringify(sealed.provenance, null, 2), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(join(evaluatorDir, "token"), randomBytes(32).toString("hex"), {
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  join(evaluatorDir, "config.json"),
  JSON.stringify(
    {
      sqliteFilename: "state/evaluations.sqlite",
      trustedPublicKeys: {
        "local-public-import": publicKey.export({ type: "spki", format: "pem" }),
      },
      bundleFiles: ["public-2024.bundle.json"],
      hostname: "127.0.0.1",
      port: 8790,
      deployment: "local_process",
    },
    null,
    2
  ),
  { flag: "wx", mode: 0o600 }
);
// The signing private key is ephemeral; no private key or sealed bars enter the research directory.
const manifest = {
  ...design,
  snapshotId: record.snapshot.snapshotId,
  provenance: dev.provenance,
  sealedDatasetId: payload.id,
  createdAt: new Date().toISOString(),
};
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
console.log(
  JSON.stringify(
    {
      snapshotId: manifest.snapshotId,
      sealedDatasetId: manifest.sealedDatasetId,
      developmentBars: record.meta.barCounts,
      manifest: manifestPath,
    },
    null,
    2
  )
);
