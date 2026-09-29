import { createHash } from "node:crypto";
import { z } from "zod";
import type { ResearchAttempt, ResearchProtocol } from "./types";

export const sealedDatasetDescriptorSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    maxEvaluations: z.number().int().min(1).max(100_000),
    horizonDays: z.number().int().min(1),
    groupCount: z.number().int().min(2),
    datasetFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
export type SealedDatasetDescriptor = z.infer<typeof sealedDatasetDescriptorSchema>;
export const sealedEvaluationRequestSchema = z
  .object({
    attemptId: z.string().uuid(),
    protocolFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    datasetId: z.string().min(1).max(200),
    datasetFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    candidate: z
      .object({ expr: z.string().min(1).max(10_000), lang: z.literal("qlib_expr") })
      .strict(),
    horizonDays: z.number().int().min(1).max(252),
    groupCount: z.number().int().min(2).max(100),
  })
  .strict();
export type SealedEvaluationRequest = z.infer<typeof sealedEvaluationRequestSchema>;
// An explicit allowlist prevents raw series, labels and detailed diagnostics being returned to an Agent.
export const sealedEvaluationReceiptSchema = z
  .object({
    version: z.literal("sealed-factor-v1"),
    attemptId: z.string().uuid(),
    protocolFingerprint: z.string(),
    candidateHash: z.string(),
    datasetFingerprint: z.string(),
    status: z.enum(["passed", "rejected", "insufficient_evidence"]),
    metrics: z
      .object({
        icMean: z.number().finite().nullable(),
        rankIcMean: z.number().finite().nullable(),
        observations: z.number().int().nonnegative(),
      })
      .strict(),
    reasonCodes: z.array(z.string().max(120)).max(20),
    evaluatedAt: z.string(),
  })
  .strict();
export type SealedEvaluationReceipt = z.infer<typeof sealedEvaluationReceiptSchema>;
export const candidateHash = (expr: string) =>
  `sha256:${createHash("sha256").update(expr).digest("hex")}`;

export class SealedEvaluatorClient {
  constructor(
    private readonly options: { url?: string; token?: string; fetch?: typeof fetch } = {}
  ) {}
  private configuration() {
    const url = this.options.url ?? process.env.QUBIT_RESEARCH_EVALUATOR_URL;
    const token = this.options.token ?? process.env.QUBIT_RESEARCH_EVALUATOR_TOKEN;
    if (!url && !token) return null;
    if (!url || !token) throw new Error("sealed_evaluator_configuration_incomplete");
    const parsed = new URL(url);
    if (
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.protocol !== "https:" &&
        !(
          parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
        ))
    ) {
      throw new Error("sealed_evaluator_requires_https_or_loopback");
    }
    return { url: parsed.toString().replace(/\/$/, ""), token };
  }
  private async request(path: string, body?: unknown) {
    const config = this.configuration();
    if (!config) throw new Error("sealed_evaluator_not_configured");
    const response = await (this.options.fetch ?? fetch)(`${config.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(body === undefined ? 5_000 : 100_000),
    });
    if (!response.ok) throw new Error(`sealed_evaluator_http_${response.status}`);
    const text = await response.text();
    if (text.length > 128_000) throw new Error("sealed_evaluator_response_too_large");
    return JSON.parse(text) as unknown;
  }
  async catalog(): Promise<{
    configured: boolean;
    datasets: SealedDatasetDescriptor[];
    reason?: string;
  }> {
    try {
      if (!this.configuration())
        return { configured: false, datasets: [], reason: "sealed_evaluator_not_configured" };
      const result = z
        .object({ datasets: z.array(sealedDatasetDescriptorSchema).max(100) })
        .strict()
        .parse(await this.request("/v1/datasets"));
      return { configured: true, datasets: result.datasets };
    } catch {
      return { configured: false, datasets: [], reason: "sealed_evaluator_unavailable" };
    }
  }
  async requireDataset(id: string) {
    const catalog = await this.catalog();
    if (!catalog.configured) throw new Error(catalog.reason);
    const dataset = catalog.datasets.find((entry) => entry.id === id);
    if (!dataset) throw new Error("sealed_dataset_not_found");
    return dataset;
  }
  budgetKey(dataset: SealedDatasetDescriptor) {
    // Content identity, rather than display name or project identity, owns the quota.
    return `sealed:${dataset.datasetFingerprint}`;
  }
  async evaluate(
    attempt: ResearchAttempt,
    protocol: ResearchProtocol,
    dataset: SealedDatasetDescriptor
  ): Promise<SealedEvaluationReceipt> {
    const body = sealedEvaluationRequestSchema.parse({
      attemptId: attempt.id,
      protocolFingerprint: protocol.fingerprint,
      datasetId: dataset.id,
      datasetFingerprint: dataset.datasetFingerprint,
      candidate: { expr: attempt.candidateJson.expr, lang: attempt.candidateJson.lang },
      horizonDays: protocol.spec.evaluation.horizonDays,
      groupCount: protocol.spec.evaluation.groupCount,
    });
    const receipt = sealedEvaluationReceiptSchema.parse(
      await this.request("/v1/evaluations", body)
    );
    if (
      receipt.attemptId !== attempt.id ||
      receipt.protocolFingerprint !== protocol.fingerprint ||
      receipt.candidateHash !== candidateHash(body.candidate.expr) ||
      receipt.datasetFingerprint !== dataset.datasetFingerprint
    ) {
      throw new Error("sealed_evaluator_receipt_mismatch");
    }
    return receipt;
  }
}
export const sealedEvaluatorClient = new SealedEvaluatorClient();
