import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacktestDataset } from "../provider/types";
import {
  type SealedEvaluationReceipt,
  type SealedEvaluationRequest,
  sealedEvaluationReceiptSchema,
} from "./evaluator-client";
import {
  type SignedSealedDatasetBundle,
  canonicalSealedJson,
  createSealedEvaluator,
  sealedDatasetFingerprint,
  signedSealedDatasetBundleSchema,
} from "./sealed-evaluator";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const trustedPublicKeys = {
  "test-only-signer": publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const token = "test-only-evaluator-token-32-characters";
const directories: string[] = [];
const evaluators: Array<ReturnType<typeof createSealedEvaluator>> = [];
afterEach(async () => {
  for (const evaluator of evaluators.splice(0)) evaluator.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

/** Synthetic computation fixtures exercise verifier code; they are not market evidence or production seeds. */
function syntheticDataset(verifiedFixture = false): BacktestDataset {
  const symbols = ["SYNTH_A", "SYNTH_B", "SYNTH_C", "SYNTH_D", "SYNTH_E"];
  return {
    snapshotId: "synthetic_test_snapshot",
    dataRef: "synthetic_test_data",
    asOf: "2026-05-01T00:00:00Z",
    timeframe: "1d",
    sourceIds: ["synthetic_test_only"],
    qualification: {
      useClass: verifiedFixture ? "strategy_validation" : "research_only",
      universeHistory: "verified",
      corporateActions: "verified",
      pointInTime: verifiedFixture ? "verified" : "not_verified",
      limitations: ["synthetic_test_fixture_not_market_evidence"],
    },
    barsBySymbol: Object.fromEntries(
      symbols.map((symbol, offset) => {
        let price = 100 + offset * 20;
        return [
          symbol,
          Array.from({ length: 100 }, (_, index) => {
            const open = price;
            price *= 1 + (offset - 1) * 0.001 + Math.sin(index * 0.7 + offset) * 0.005;
            return {
              timestamp: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
              open,
              high: Math.max(open, price) + 0.1,
              low: Math.min(open, price) - 0.1,
              close: price,
              volume: 1_000,
              turnover: price * 1_000,
            };
          }),
        ];
      })
    ),
  };
}

function signedBundle(
  options: {
    verified?: boolean;
    id?: string;
    maxEvaluations?: number;
    dataset?: BacktestDataset;
  } = {}
): SignedSealedDatasetBundle {
  const payload = {
    version: "sealed-factor-dataset-v1" as const,
    id: options.id ?? "synthetic-sealed",
    label: "Synthetic evaluator test data",
    maxEvaluations: options.maxEvaluations ?? 5,
    horizonDays: 5,
    groupCount: 3,
    dataset: options.dataset ?? syntheticDataset(options.verified),
    ...(options.verified
      ? {
          pointInTimeEvidence: {
            issuer: "synthetic-test-only-signer",
            reference: "test-fixture-not-real-market-provenance",
            statement: "historical_availability_verified" as const,
          },
        }
      : {}),
  };
  return signedSealedDatasetBundleSchema.parse({
    keyId: "test-only-signer",
    payload,
    signature: sign(null, Buffer.from(canonicalSealedJson(payload)), privateKey).toString("base64"),
  });
}

function evaluation(datasetId = "synthetic-sealed", expr = "$close"): SealedEvaluationRequest {
  return {
    attemptId: randomUUID(),
    protocolFingerprint: `sha256:${"a".repeat(64)}`,
    datasetId,
    datasetFingerprint: sealedDatasetFingerprint(syntheticDataset()),
    candidate: { expr, lang: "qlib_expr" },
    horizonDays: 5,
    groupCount: 3,
  };
}

function post(input: SealedEvaluationRequest): Request {
  return new Request("http://localhost/v1/evaluations", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
}

async function start(bundles = [signedBundle()], sqliteFilename?: string) {
  let filename = sqliteFilename;
  if (!filename) {
    const directory = await mkdtemp(join(tmpdir(), "qubit-sealed-test-"));
    directories.push(directory);
    filename = join(directory, "evaluator.sqlite");
  }
  const evaluator = createSealedEvaluator({
    token,
    sqliteFilename: filename,
    trustedPublicKeys,
    bundles,
  });
  evaluators.push(evaluator);
  return { evaluator, filename };
}

function stop(evaluator: ReturnType<typeof createSealedEvaluator>) {
  const index = evaluators.indexOf(evaluator);
  if (index >= 0) evaluators.splice(index, 1);
  evaluator.close();
}

describe("isolated signed-data factor evaluator", () => {
  test("a dataset replaced after catalog selection is rejected before spending either version's quota", async () => {
    const original = signedBundle({ maxEvaluations: 1 });
    const selected = evaluation();
    const first = await start([original]);
    stop(first.evaluator);
    const changed = syntheticDataset();
    const bar = changed.barsBySymbol.SYNTH_A?.[0];
    if (!bar) throw new Error("missing_fixture_bar");
    bar.close += 0.01;
    bar.turnover = bar.close * bar.volume;
    const replacement = signedBundle({ maxEvaluations: 1, dataset: changed });
    const currentFingerprint = sealedDatasetFingerprint(changed);
    expect(currentFingerprint).not.toBe(selected.datasetFingerprint);
    const restarted = await start([replacement], first.filename);
    const stale = await restarted.evaluator.fetch(post(selected));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "sealed_dataset_version_changed" });
    const { datasetFingerprint: _missing, ...withoutFingerprint } = selected;
    const missing = await restarted.evaluator.fetch(
      new Request("http://localhost/v1/evaluations", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(withoutFingerprint),
      })
    );
    expect(missing.status).toBe(400);
    const db = new Database(first.filename, { readonly: true });
    try {
      expect(
        db
          .query<{ used: number }, []>("SELECT used FROM sealed_quota")
          .all()
          .every((row) => row.used === 0)
      ).toBe(true);
      expect(
        db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sealed_evaluation").get()
          ?.count
      ).toBe(0);
      // The rejected request never reserved its idempotency key or allowance.
      expect(
        (
          await restarted.evaluator.fetch(
            post({ ...selected, datasetFingerprint: currentFingerprint })
          )
        ).status
      ).toBe(200);
      expect(
        db
          .query<{ used: number }, [string]>("SELECT used FROM sealed_quota WHERE fingerprint = ?")
          .get(currentFingerprint)?.used
      ).toBe(1);
      expect(
        db
          .query<{ used: number }, [string]>("SELECT used FROM sealed_quota WHERE fingerprint = ?")
          .get(selected.datasetFingerprint)?.used
      ).toBe(0);
    } finally {
      db.close();
    }
  });
  test("requires authentication and exposes only descriptors, never raw sealed data", async () => {
    const { evaluator } = await start();
    expect((await evaluator.fetch(new Request("http://localhost/v1/datasets"))).status).toBe(401);
    const response = await evaluator.fetch(
      new Request("http://localhost/v1/datasets", { headers: { Authorization: `Bearer ${token}` } })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("barsBySymbol");
    expect(text).not.toContain("synthetic_test_data");
    const catalog = JSON.parse(text) as { datasets: Array<{ startDate: string; endDate: string }> };
    expect(catalog.datasets[0]).toMatchObject({ startDate: "2026-01-01", endDate: "2026-04-10" });
  });

  test("fails startup for tampered bundle payload or an untrusted signer", () => {
    const original = signedBundle();
    const tampered = structuredClone(original);
    tampered.payload.label = "Tampered";
    expect(() =>
      createSealedEvaluator({
        token,
        sqliteFilename: ":memory:",
        trustedPublicKeys,
        bundles: [tampered],
      })
    ).toThrow("sealed_dataset_signature_invalid");
    expect(() =>
      createSealedEvaluator({
        token,
        sqliteFilename: ":memory:",
        trustedPublicKeys: {},
        bundles: [original],
      })
    ).toThrow("sealed_dataset_untrusted_signer");
    expect(() =>
      createSealedEvaluator({
        token,
        sqliteFilename: ":memory:",
        trustedPublicKeys,
        bundles: [{ ...original, signature: undefined }],
      })
    ).toThrow();
  });

  test("a valid source signature without PIT evidence cannot pass", async () => {
    const { evaluator } = await start();
    const response = await evaluator.fetch(post(evaluation()));
    const result = sealedEvaluationReceiptSchema.parse(await response.json());
    expect(result.status).toBe("insufficient_evidence");
    expect(result.reasonCodes).toContain("signed_pit_attestation_missing");
    expect(result.metrics.icMean).toBeNull();
  });

  test("synthetic verified test metadata exercises only builtin computation and aggregate output", async () => {
    const { evaluator } = await start([signedBundle({ verified: true })]);
    const response = await evaluator.fetch(post(evaluation()));
    expect(response.status).toBe(200);
    const json = await response.json();
    const result = sealedEvaluationReceiptSchema.parse(json);
    expect(result.status).not.toBe("insufficient_evidence");
    expect(result.metrics.observations).toBe(95);
    expect(result.metrics.rankIcMean).not.toBeNull();
    expect(Object.keys(json as object).sort()).toEqual(
      [
        "attemptId",
        "candidateHash",
        "datasetFingerprint",
        "evaluatedAt",
        "metrics",
        "protocolFingerprint",
        "reasonCodes",
        "status",
        "version",
      ].sort()
    );
    expect(JSON.stringify(json)).not.toContain("rows");
    expect(JSON.stringify(json)).not.toContain("futureReturns");
  });

  test("negative future references are rejected before compute and still consume quota", async () => {
    const { evaluator } = await start([signedBundle({ verified: true, maxEvaluations: 1 })]);
    const result = sealedEvaluationReceiptSchema.parse(
      await (await evaluator.fetch(post(evaluation("synthetic-sealed", "Ref($close, -1)")))).json()
    );
    expect(result.status).toBe("rejected");
    expect(result.reasonCodes).toContain("future_reference");
    expect((await evaluator.fetch(post(evaluation()))).status).toBe(409);
  });

  test("unsupported expression work budgets never fall through to provider evaluation", async () => {
    const { evaluator } = await start([signedBundle({ verified: true })]);
    const result = sealedEvaluationReceiptSchema.parse(
      await (
        await evaluator.fetch(post(evaluation("synthetic-sealed", "Mean($close, 100000)")))
      ).json()
    );
    expect(result.status).toBe("insufficient_evidence");
    expect(result.metrics.observations).toBe(0);
  });

  test("idempotency survives restart and changed requests conflict", async () => {
    const { evaluator, filename } = await start([signedBundle({ maxEvaluations: 1 })]);
    const input = evaluation();
    const first = await (await evaluator.fetch(post(input))).json();
    expect(await (await evaluator.fetch(post(input))).json()).toEqual(first);
    expect(
      (await evaluator.fetch(post({ ...input, candidate: { lang: "qlib_expr", expr: "$volume" } })))
        .status
    ).toBe(409);
    stop(evaluator);
    const restarted = await start([signedBundle({ maxEvaluations: 1 })], filename);
    expect(await (await restarted.evaluator.fetch(post(input))).json()).toEqual(first);
    expect((await restarted.evaluator.fetch(post(evaluation()))).status).toBe(409);
  });

  test("parallel different attempts cannot overspend one dataset quota", async () => {
    const { evaluator } = await start([signedBundle({ maxEvaluations: 2 })]);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => evaluator.fetch(post(evaluation())))
    );
    expect(results.filter((result) => result.status === 200)).toHaveLength(2);
    expect(results.filter((result) => result.status === 409)).toHaveLength(6);
  });

  test("renaming dataset and snapshot identities does not reset quota or raise its immutable cap", async () => {
    const original = signedBundle({ maxEvaluations: 1 });
    const aliasData = syntheticDataset();
    aliasData.snapshotId = "another_snapshot_name";
    aliasData.dataRef = "another_reference";
    aliasData.asOf = "2026-05-02T00:00:00Z";
    const alias = signedBundle({ id: "renamed", maxEvaluations: 1, dataset: aliasData });
    expect(sealedDatasetFingerprint(aliasData)).toBe(sealedDatasetFingerprint(syntheticDataset()));
    const { evaluator, filename } = await start([original, alias]);
    expect((await evaluator.fetch(post(evaluation()))).status).toBe(200);
    expect((await evaluator.fetch(post(evaluation("renamed")))).status).toBe(409);
    stop(evaluator);
    expect(() =>
      createSealedEvaluator({
        token,
        sqliteFilename: filename,
        trustedPublicKeys,
        bundles: [signedBundle({ id: "renamed", maxEvaluations: 2, dataset: aliasData })],
      })
    ).toThrow("sealed_quota_immutable");
  });

  test("a crashed running evaluation is retained as failed and never rerun", async () => {
    const bundle = signedBundle({ maxEvaluations: 1 });
    const { evaluator, filename } = await start([bundle]);
    const input = evaluation();
    await evaluator.fetch(post(input));
    stop(evaluator);
    // Simulate the persisted state at a process crash after reservation but before receipt commit.
    const db = new Database(filename);
    db.query(
      "UPDATE sealed_evaluation SET status = 'running', receipt_json = NULL WHERE id = ?"
    ).run(input.attemptId);
    db.close();
    const restarted = await start([bundle], filename);
    const result = (await (
      await restarted.evaluator.fetch(post(input))
    ).json()) as SealedEvaluationReceipt;
    expect(result.status).toBe("insufficient_evidence");
    expect(result.reasonCodes).toContain("evaluator_restarted_during_attempt");
    expect((await restarted.evaluator.fetch(post(evaluation()))).status).toBe(409);
  });

  test("signed future bars cannot be certified by metadata alone", async () => {
    const dataset = syntheticDataset(true);
    dataset.asOf = "2026-01-02T00:00:00Z";
    const { evaluator } = await start([signedBundle({ verified: true, dataset })]);
    const result = (await (
      await evaluator.fetch(post(evaluation()))
    ).json()) as SealedEvaluationReceipt;
    expect(result.status).toBe("rejected");
    expect(result.reasonCodes).toContain("point_in_time_violated");
  });
});
