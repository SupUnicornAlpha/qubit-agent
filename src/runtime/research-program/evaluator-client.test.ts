import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type SealedDatasetDescriptor,
  SealedEvaluatorClient,
  candidateHash,
} from "./evaluator-client";
import type { ResearchAttempt, ResearchProtocol } from "./types";
const dataset: SealedDatasetDescriptor = {
  id: "sealed",
  label: "Independent dataset",
  startDate: "2025-01-01",
  endDate: "2025-12-31",
  maxEvaluations: 2,
  horizonDays: 5,
  groupCount: 3,
  datasetFingerprint: `sha256:${"a".repeat(64)}`,
};
const attempt = {
  id: randomUUID(),
  candidateJson: { expr: "close", lang: "qlib_expr" },
} as unknown as ResearchAttempt;
const protocol = {
  fingerprint: `sha256:${"b".repeat(64)}`,
  spec: { evaluation: { horizonDays: 5, groupCount: 3 } },
} as ResearchProtocol;
const receipt = {
  version: "sealed-factor-v1",
  attemptId: attempt.id,
  protocolFingerprint: protocol.fingerprint,
  candidateHash: candidateHash("close"),
  datasetFingerprint: dataset.datasetFingerprint,
  status: "insufficient_evidence",
  metrics: { icMean: null, rankIcMean: null, observations: 0 },
  reasonCodes: ["pit_unverified"],
  evaluatedAt: new Date().toISOString(),
};
function client(response: unknown) {
  return new SealedEvaluatorClient({
    url: "https://evaluator.test",
    token: "fixture",
    fetch: (async () => Response.json(response)) as unknown as typeof fetch,
  });
}
describe("independent evaluator client", () => {
  test("sends the selected dataset fingerprint in the request, before remote execution", async () => {
    let requested: Record<string, unknown> = {};
    const evaluator = new SealedEvaluatorClient({
      url: "https://evaluator.test",
      token: "fixture",
      fetch: (async (_url: string, options: RequestInit) => {
        requested = JSON.parse(String(options.body));
        return Response.json(receipt);
      }) as typeof fetch,
    });
    await evaluator.evaluate(attempt, protocol, dataset);
    expect(requested.datasetFingerprint).toBe(dataset.datasetFingerprint);
  });
  test("accepts only receipts bound to this attempt, expression, protocol and dataset", async () => {
    expect((await client(receipt).evaluate(attempt, protocol, dataset)).status).toBe(
      "insufficient_evidence"
    );
    for (const key of ["attemptId", "protocolFingerprint", "candidateHash", "datasetFingerprint"]) {
      await expect(
        client({ ...receipt, [key]: key === "attemptId" ? randomUUID() : "wrong" }).evaluate(
          attempt,
          protocol,
          dataset
        )
      ).rejects.toThrow();
    }
  });
  test("refuses data-bearing responses and quota aliases cannot reset identity", async () => {
    await expect(
      client({ ...receipt, rawLabels: [1, 2] }).evaluate(attempt, protocol, dataset)
    ).rejects.toThrow();
    expect(client({}).budgetKey(dataset)).toBe(
      client({}).budgetKey({ ...dataset, id: "renamed", label: "renamed" })
    );
  });
  test("unconfigured and unsafe remote connections do not become available", async () => {
    expect((await new SealedEvaluatorClient({ url: "", token: "" }).catalog()).configured).toBe(
      false
    );
    expect(
      (await new SealedEvaluatorClient({ url: "http://public.example", token: "x" }).catalog())
        .configured
    ).toBe(false);
  });
  test("partial configuration remains unavailable rather than silently unconfigured", async () => {
    for (const options of [
      { url: "https://evaluator.test", token: "" },
      { url: "", token: "secret" },
    ]) {
      expect(await new SealedEvaluatorClient(options).catalog()).toMatchObject({
        configured: false,
        reason: "sealed_evaluator_unavailable",
      });
    }
  });
});
