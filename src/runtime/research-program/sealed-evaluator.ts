import { Database } from "bun:sqlite";
import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { z } from "zod";
import { assessFactorDataIntegrity } from "../factor/factor-data-integrity";
import { pointInTimeMillis } from "../market/contracts/point-in-time-clock";
import { BuiltinFactorEvalProvider } from "../provider/impls/factor/builtin-factor-eval-provider";
import { QlibExprFactorProvider } from "../provider/impls/factor/qlib-expr-factor-provider";
import type { BacktestDataset, FactorComputeRow } from "../provider/types";
import {
  type SealedDatasetDescriptor,
  type SealedEvaluationReceipt,
  type SealedEvaluationRequest,
  candidateHash,
  sealedEvaluationReceiptSchema,
  sealedEvaluationRequestSchema,
} from "./evaluator-client";

const timestamp = z
  .string()
  .refine((value) => Number.isFinite(pointInTimeMillis(value)), "timestamp_invalid");
const finite = z.number().finite();
const datasetSchema = z
  .object({
    snapshotId: z.string().min(1),
    dataRef: z.string().min(1),
    asOf: timestamp,
    timeframe: z.literal("1d"),
    sourceIds: z.array(z.string().min(1)).min(1),
    barsBySymbol: z.record(
      z
        .array(
          z
            .object({
              timestamp,
              open: finite,
              high: finite,
              low: finite,
              close: finite,
              volume: finite,
              turnover: finite,
            })
            .passthrough()
        )
        .min(1)
    ),
    fundamentalObservations: z
      .array(
        z
          .object({
            symbol: z.string().min(1),
            metric: z.string().min(1),
            fiscalPeriodEnd: z.string(),
            availableAt: timestamp,
            value: finite,
            revisionId: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    corporateActionEvents: z
      .array(
        z
          .object({
            symbol: z.string().min(1),
            effectiveDate: z.string(),
            knownAt: timestamp,
            kind: z.string(),
            cashAmount: finite.optional(),
          })
          .strict()
      )
      .optional(),
    qualification: z
      .object({
        useClass: z.enum(["research_only", "strategy_validation"]),
        universeHistory: z.enum(["verified", "not_verified"]),
        corporateActions: z.enum(["verified", "raw_unadjusted", "not_verified"]),
        pointInTime: z.enum(["verified", "not_verified"]),
        limitations: z.array(z.string()),
      })
      .passthrough(),
  })
  .passthrough()
  .superRefine((value, context) => {
    const bars = Object.values(value.barsBySymbol);
    if (
      bars.length < 3 ||
      bars.length > 500 ||
      bars.reduce((sum, rows) => sum + rows.length, 0) > 100_000
    ) {
      context.addIssue({ code: "custom", message: "dataset_size_out_of_bounds" });
    }
  });

export const signedSealedDatasetBundleSchema = z
  .object({
    keyId: z.string().min(1).max(100),
    signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
    payload: z
      .object({
        version: z.literal("sealed-factor-dataset-v1"),
        id: z.string().min(1).max(200),
        label: z.string().min(1).max(200),
        maxEvaluations: z.number().int().min(1).max(100_000),
        horizonDays: z.number().int().min(1).max(252),
        groupCount: z.number().int().min(2).max(100),
        dataset: datasetSchema,
        pointInTimeEvidence: z
          .object({
            reference: z.string().min(1),
            issuer: z.string().min(1),
            statement: z.literal("historical_availability_verified"),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export type SignedSealedDatasetBundle = z.infer<typeof signedSealedDatasetBundleSchema>;

/** The producer signs these exact UTF-8 bytes, with Ed25519 (algorithm=null). */
export function canonicalSealedJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("sealed_json_invalid");
    return json;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSealedJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalSealedJson(entry)}`)
    .join(",")}}`;
}

const fingerprint = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalSealedJson(value)).digest("hex")}`;
const iso = (value: string) => new Date(pointInTimeMillis(value)).toISOString();

const compareCanonicalText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

/** Data identity excludes aliases, project/protocol names, declared quality, asOf and allowances. */
export function sealedDatasetFingerprint(dataset: BacktestDataset): string {
  return fingerprint({
    timeframe: dataset.timeframe,
    barsBySymbol: Object.fromEntries(
      Object.entries(dataset.barsBySymbol).map(([symbol, bars]) => [
        symbol,
        bars
          .map((bar) => ({ ...bar, timestamp: iso(bar.timestamp) }))
          .sort((a, b) => compareCanonicalText(a.timestamp, b.timestamp)),
      ])
    ),
    fundamentalObservations: (dataset.fundamentalObservations ?? [])
      .map((entry) => ({ ...entry, availableAt: iso(entry.availableAt) }))
      .sort((a, b) => compareCanonicalText(canonicalSealedJson(a), canonicalSealedJson(b))),
    corporateActionEvents: (dataset.corporateActionEvents ?? [])
      .map((entry) => ({ ...entry, knownAt: iso(entry.knownAt) }))
      .sort((a, b) => compareCanonicalText(canonicalSealedJson(a), canonicalSealedJson(b))),
  });
}

type DatasetEntry = {
  descriptor: SealedDatasetDescriptor;
  dataset: BacktestDataset;
  hasPitEvidence: boolean;
};
type EvaluationRow = {
  id: string;
  request_hash: string;
  request_json: string;
  dataset_fingerprint: string;
  status: "running" | "completed" | "failed";
  receipt_json: string | null;
};

function receipt(
  request: SealedEvaluationRequest,
  datasetFingerprint: string,
  status: SealedEvaluationReceipt["status"],
  reasonCodes: string[],
  metrics: SealedEvaluationReceipt["metrics"] = { icMean: null, rankIcMean: null, observations: 0 }
): SealedEvaluationReceipt {
  return sealedEvaluationReceiptSchema.parse({
    version: "sealed-factor-v1",
    attemptId: request.attemptId,
    protocolFingerprint: request.protocolFingerprint,
    candidateHash: candidateHash(request.candidate.expr),
    datasetFingerprint,
    status,
    metrics,
    reasonCodes,
    evaluatedAt: new Date().toISOString(),
  });
}

export function createSealedEvaluator(options: {
  sqliteFilename: string;
  token: string;
  trustedPublicKeys: Record<string, string>;
  bundles: unknown[];
}) {
  if (options.token.length < 16) throw new Error("sealed_evaluator_token_too_short");
  if (options.bundles.length > 100) throw new Error("sealed_dataset_catalog_too_large");
  const datasets = new Map<string, DatasetEntry>();
  for (const raw of options.bundles) {
    // Validate structure without dropping producer-signed fields before signature verification.
    const bundle = signedSealedDatasetBundleSchema.parse(raw);
    const publicKey = options.trustedPublicKeys[bundle.keyId];
    if (!publicKey) throw new Error("sealed_dataset_untrusted_signer");
    const key = createPublicKey(publicKey);
    if (
      key.asymmetricKeyType !== "ed25519" ||
      !verify(
        null,
        Buffer.from(canonicalSealedJson((raw as SignedSealedDatasetBundle).payload)),
        key,
        Buffer.from(bundle.signature, "base64")
      )
    ) {
      throw new Error("sealed_dataset_signature_invalid");
    }
    if (datasets.has(bundle.payload.id)) throw new Error("sealed_dataset_id_duplicate");
    const dataset = structuredClone(bundle.payload.dataset) as BacktestDataset;
    // The built-in daily provider keys rows by timestamp prefix. Normalize
    // equivalent offset instants first so cross-sections cannot misjoin dates.
    dataset.asOf = iso(dataset.asOf);
    for (const bars of Object.values(dataset.barsBySymbol)) {
      for (const bar of bars) bar.timestamp = iso(bar.timestamp);
    }
    const dates = Object.values(dataset.barsBySymbol)
      .flatMap((bars) => bars.map((bar) => iso(bar.timestamp).slice(0, 10)))
      .sort();
    const startDate = dates[0];
    const endDate = dates.at(-1);
    if (!startDate || !endDate) throw new Error("sealed_dataset_empty");
    datasets.set(bundle.payload.id, {
      dataset,
      hasPitEvidence: Boolean(bundle.payload.pointInTimeEvidence),
      descriptor: {
        id: bundle.payload.id,
        label: bundle.payload.label,
        startDate,
        endDate,
        maxEvaluations: bundle.payload.maxEvaluations,
        horizonDays: bundle.payload.horizonDays,
        groupCount: bundle.payload.groupCount,
        datasetFingerprint: sealedDatasetFingerprint(dataset),
      },
    });
  }
  const db = new Database(options.sqliteFilename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;");
  db.exec(`CREATE TABLE IF NOT EXISTS sealed_quota (
    fingerprint TEXT PRIMARY KEY NOT NULL, allowance INTEGER NOT NULL CHECK(allowance > 0),
    used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0 AND used <= allowance));
    CREATE TABLE IF NOT EXISTS sealed_evaluation (
      id TEXT PRIMARY KEY NOT NULL, request_hash TEXT NOT NULL, request_json TEXT NOT NULL,
      dataset_fingerprint TEXT NOT NULL REFERENCES sealed_quota(fingerprint),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed')), receipt_json TEXT);
    CREATE TRIGGER IF NOT EXISTS sealed_quota_limit_immutable BEFORE UPDATE ON sealed_quota
      WHEN NEW.allowance <> OLD.allowance BEGIN SELECT RAISE(ABORT, 'sealed_quota_immutable'); END;`);
  try {
    db.transaction(() => {
      for (const entry of datasets.values()) {
        const old = db
          .query<{ allowance: number }, [string]>(
            "SELECT allowance FROM sealed_quota WHERE fingerprint = ?"
          )
          .get(entry.descriptor.datasetFingerprint);
        if (old && old.allowance !== entry.descriptor.maxEvaluations)
          throw new Error("sealed_quota_immutable");
        db.query("INSERT OR IGNORE INTO sealed_quota (fingerprint, allowance) VALUES (?, ?)").run(
          entry.descriptor.datasetFingerprint,
          entry.descriptor.maxEvaluations
        );
      }
      // A prior process may have consumed evidence before dying. Never rerun it or refund the budget.
      for (const row of db
        .query<EvaluationRow, []>("SELECT * FROM sealed_evaluation WHERE status = 'running'")
        .all()) {
        const original = sealedEvaluationRequestSchema.parse(JSON.parse(row.request_json));
        const interrupted = receipt(original, row.dataset_fingerprint, "insufficient_evidence", [
          "evaluator_restarted_during_attempt",
        ]);
        db.query(
          "UPDATE sealed_evaluation SET status = 'failed', receipt_json = ? WHERE id = ? AND status = 'running'"
        ).run(JSON.stringify(interrupted), row.id);
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  const compute = new QlibExprFactorProvider();
  const evaluate = new BuiltinFactorEvalProvider();
  let closed = false;

  async function calculate(
    request: SealedEvaluationRequest,
    entry: DatasetEntry
  ): Promise<SealedEvaluationReceipt> {
    const datasetFingerprint = entry.descriptor.datasetFingerprint;
    const integrity = assessFactorDataIntegrity({
      factorId: request.attemptId,
      expr: request.candidate.expr,
      lang: "qlib_expr",
      providerKey: "qlib_expr",
      dataset: entry.dataset,
      startDate: entry.descriptor.startDate,
      endDate: entry.descriptor.endDate,
    });
    if (integrity.status === "failed") {
      return receipt(
        request,
        datasetFingerprint,
        "rejected",
        [
          ...(integrity.pit.verdict === "point_in_time_violated" ? ["point_in_time_violated"] : []),
          ...(integrity.truncation?.issues.map((issue) => issue.code) ?? []),
        ].slice(0, 20)
      );
    }
    if (!entry.hasPitEvidence || integrity.status !== "passed") {
      return receipt(request, datasetFingerprint, "insufficient_evidence", [
        ...(!entry.hasPitEvidence ? ["signed_pit_attestation_missing"] : []),
        ...(integrity.status !== "passed" ? ["data_integrity_not_verified"] : []),
      ]);
    }
    const values = await compute.compute({
      factorId: request.attemptId,
      expr: request.candidate.expr,
      lang: "qlib_expr",
      universe: "sealed",
      symbols: Object.keys(entry.dataset.barsBySymbol),
      startDate: entry.descriptor.startDate,
      endDate: entry.descriptor.endDate,
      dataset: entry.dataset,
    });
    if (values.meta.error)
      return receipt(request, datasetFingerprint, "rejected", ["factor_computation_failed"]);
    const futures: FactorComputeRow[] = [];
    for (const [symbol, bars] of Object.entries(entry.dataset.barsBySymbol)) {
      for (let index = 0; index < bars.length; index++) {
        const current = bars[index];
        const next = bars[index + request.horizonDays];
        if (!current || !next) continue;
        futures.push({
          symbol,
          date: current.timestamp.slice(0, 10),
          value: next.close / current.close - 1,
        });
      }
    }
    const result = await evaluate.evaluate({
      factorId: candidateHash(request.candidate.expr),
      values: values.rows,
      futureReturns: futures,
      horizonDays: request.horizonDays,
      groupCount: request.groupCount,
      universe: "sealed",
    });
    const dailyObservations = result.statisticalReport?.dailyObservations ?? 0;
    if (result.error || dailyObservations < 60) {
      return receipt(
        request,
        datasetFingerprint,
        "insufficient_evidence",
        ["insufficient_independent_daily_observations"],
        {
          icMean: Number.isFinite(result.ic) ? result.ic : null,
          rankIcMean: Number.isFinite(result.rankIc) ? result.rankIc : null,
          observations: dailyObservations,
        }
      );
    }
    const passed = result.statisticalReport?.status === "passed" && result.rankIc > 0;
    return receipt(
      request,
      datasetFingerprint,
      passed ? "passed" : "rejected",
      [passed ? "sealed_prediction_gate_passed" : "sealed_prediction_gate_not_met"],
      { icMean: result.ic, rankIcMean: result.rankIc, observations: dailyObservations }
    );
  }

  const authorization = Buffer.from(`Bearer ${options.token}`);
  return {
    async fetch(request: Request): Promise<Response> {
      const supplied = Buffer.from(request.headers.get("authorization") ?? "");
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (closed) return Response.json({ error: "evaluator_closed" }, { status: 503 });
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/v1/datasets") {
        return Response.json({ datasets: [...datasets.values()].map((entry) => entry.descriptor) });
      }
      if (request.method !== "POST" || path !== "/v1/evaluations")
        return Response.json({ error: "not_found" }, { status: 404 });
      const body = await request.text();
      if (body.length > 32_000)
        return Response.json({ error: "request_too_large" }, { status: 413 });
      let input: SealedEvaluationRequest;
      try {
        input = sealedEvaluationRequestSchema.parse(JSON.parse(body));
      } catch {
        return Response.json({ error: "evaluation_request_invalid" }, { status: 400 });
      }
      const entry = datasets.get(input.datasetId);
      if (!entry) return Response.json({ error: "sealed_dataset_not_found" }, { status: 404 });
      // Pin the selected version before any quota reservation. A deployment
      // replacing a dataset alias must not spend a different version's budget.
      if (input.datasetFingerprint !== entry.descriptor.datasetFingerprint) {
        return Response.json({ error: "sealed_dataset_version_changed" }, { status: 409 });
      }
      if (
        input.horizonDays !== entry.descriptor.horizonDays ||
        input.groupCount !== entry.descriptor.groupCount
      ) {
        return Response.json({ error: "evaluation_method_mismatch" }, { status: 409 });
      }
      const requestHash = fingerprint(input);
      const reservation = db
        .transaction(() => {
          const existing = db
            .query<EvaluationRow, [string]>("SELECT * FROM sealed_evaluation WHERE id = ?")
            .get(input.attemptId);
          if (existing) {
            if (
              existing.request_hash !== requestHash ||
              existing.dataset_fingerprint !== entry.descriptor.datasetFingerprint
            )
              return { error: "idempotency_conflict" };
            return existing.receipt_json
              ? { prior: existing.receipt_json }
              : { error: "evaluation_in_progress" };
          }
          const quota = db
            .query(
              "UPDATE sealed_quota SET used = used + 1 WHERE fingerprint = ? AND used < allowance"
            )
            .run(entry.descriptor.datasetFingerprint);
          if (quota.changes !== 1) return { error: "sealed_evaluation_budget_exhausted" };
          db.query(
            "INSERT INTO sealed_evaluation (id, request_hash, request_json, dataset_fingerprint, status) VALUES (?, ?, ?, ?, 'running')"
          ).run(
            input.attemptId,
            requestHash,
            JSON.stringify(input),
            entry.descriptor.datasetFingerprint
          );
          return { reserved: true };
        })
        .immediate();
      if (reservation.error) return Response.json({ error: reservation.error }, { status: 409 });
      if (reservation.prior)
        return Response.json(sealedEvaluationReceiptSchema.parse(JSON.parse(reservation.prior)));
      let result: SealedEvaluationReceipt;
      let failed = false;
      try {
        result = await calculate(input, entry);
      } catch {
        failed = true;
        result = receipt(input, entry.descriptor.datasetFingerprint, "insufficient_evidence", [
          "sealed_evaluation_failed",
        ]);
      }
      const update = db
        .query(
          "UPDATE sealed_evaluation SET status = ?, receipt_json = ? WHERE id = ? AND status = 'running'"
        )
        .run(failed ? "failed" : "completed", JSON.stringify(result), input.attemptId);
      if (update.changes !== 1) {
        const stored = db
          .query<EvaluationRow, [string]>("SELECT * FROM sealed_evaluation WHERE id = ?")
          .get(input.attemptId);
        if (stored?.receipt_json)
          return Response.json(
            sealedEvaluationReceiptSchema.parse(JSON.parse(stored.receipt_json))
          );
        return Response.json({ error: "evaluation_state_conflict" }, { status: 409 });
      }
      return Response.json(result);
    },
    close() {
      closed = true;
      db.close();
    },
  };
}
