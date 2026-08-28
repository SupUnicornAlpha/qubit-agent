/**
 * ExternalMlFactorProvider — 把外部模型 / 实时打分服务接到 FactorCompute 面
 *
 * key: external_ml
 * lang: ml_score
 *
 * 调度路径：
 *   FactorService.compute → this.compute → ModelFactorAdapter.infer → FactorComputeRow[]
 *
 * 不实现训练；只做对接与血缘透传（datasetSnapshotId / model binding）。
 */

import { randomUUID } from "node:crypto";
import {
  type ModelFactorBinding,
  extractModelFactorBinding,
  buildModelFactorExpr,
} from "../../model-factor-contract";
import type {
  FactorComputeProvider,
  FactorComputeRequest,
  FactorComputeResult,
  ProviderMeta,
} from "../../types";
import { getModelFactorAdapter } from "./model-factor-adapter-registry";

const META: ProviderMeta = {
  kind: "factor_compute",
  key: "external_ml",
  displayName: "External ML / model-factor bridge",
  description:
    "Delegates factor scores to registered ModelFactorAdapter implementations (in-process or HTTP). Supports snapshot-bound inference for auditability.",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "future", "option", "crypto", "fx"],
    features: [
      "ml_score",
      "model_factor",
      "snapshot_bound",
      "external_adapter",
      "http_bridge",
    ],
    performanceProfile: "batch",
  },
  isBuiltin: true,
  isFallback: false,
};

function resolveBinding(input: FactorComputeRequest): ModelFactorBinding {
  const fromDef = extractModelFactorBinding(input.definition);
  if (fromDef) return fromDef;
  throw new Error(
    "external_ml requires definition.modelFactor binding (adapterKey, modelId, modelVersion)"
  );
}

export class ExternalMlFactorProvider implements FactorComputeProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
    return { ok: true };
  }

  async validateExpr(expr: string, lang: string): Promise<{ ok: boolean; error?: string }> {
    if (lang !== "ml_score") {
      return {
        ok: false,
        error: `external_ml Provider expects lang='ml_score', got '${lang}'`,
      };
    }
    if (!expr.trim()) {
      return { ok: false, error: "empty_model_factor_expr" };
    }
    if (!expr.trim().startsWith("model://") && !expr.trim().startsWith("{")) {
      // Allow JSON expr for ad-hoc register; prefer model:// URI.
      return {
        ok: true,
        error: undefined,
      };
    }
    return { ok: true };
  }

  async compute(input: FactorComputeRequest): Promise<FactorComputeResult> {
    const t0 = Date.now();
    if (input.lang !== "ml_score") {
      return this.emptyResult(input, t0, `unsupported_lang:${input.lang}`);
    }

    let binding: ModelFactorBinding;
    try {
      binding = resolveBinding(input);
    } catch (e) {
      return this.emptyResult(input, t0, (e as Error).message);
    }

    const symbols = (input.symbols ?? []).map((s) => s.trim()).filter(Boolean);
    if (symbols.length === 0) {
      return this.emptyResult(input, t0, "symbols_required_for_model_factor");
    }

    try {
      const adapter = getModelFactorAdapter(binding.adapterKey);
      const infer = await adapter.infer({
        protocolVersion: binding.protocolVersion,
        requestId: randomUUID(),
        binding,
        factorId: input.factorId,
        universe: input.universe,
        symbols,
        startDate: input.startDate,
        endDate: input.endDate,
        ...(input.dataset
          ? {
              datasetSnapshotId: input.dataset.snapshotId,
              dataset: input.dataset,
              asOf: input.dataset.asOf,
            }
          : {}),
      });

      if (!infer.ok) {
        return this.emptyResult(input, t0, infer.error ?? "model_factor_infer_failed", {
          adapterKey: binding.adapterKey,
          ...(infer.meta ?? {}),
        });
      }

      const rows = (infer.rows ?? []).map((r) => ({
        symbol: r.symbol,
        date: String(r.date).slice(0, 10),
        value: r.value === null || r.value === undefined
          ? null
          : Number.isFinite(Number(r.value))
            ? Number(r.value)
            : null,
      }));

      return {
        rows,
        meta: {
          factorId: input.factorId,
          rowCount: rows.length,
          latencyMs: Date.now() - t0,
          ...(input.dataset
            ? {
                datasetSnapshotId: input.dataset.snapshotId,
                sourceIds: input.dataset.sourceIds,
              }
            : {}),
          modelFactor: {
            adapterKey: binding.adapterKey,
            modelId: binding.modelId,
            modelVersion: binding.modelVersion,
            expr: buildModelFactorExpr(binding),
            ...(binding.contentHash ? { contentHash: binding.contentHash } : {}),
            ...(binding.artifactUri ? { artifactUri: binding.artifactUri } : {}),
          },
          ...(infer.meta ?? {}),
        },
      };
    } catch (e) {
      return this.emptyResult(input, t0, (e as Error).message, {
        adapterKey: binding.adapterKey,
      });
    }
  }

  private emptyResult(
    input: FactorComputeRequest,
    t0: number,
    error?: string,
    extraMeta?: Record<string, unknown>
  ): FactorComputeResult {
    return {
      rows: [],
      meta: {
        factorId: input.factorId,
        rowCount: 0,
        latencyMs: Date.now() - t0,
        ...(input.dataset ? { datasetSnapshotId: input.dataset.snapshotId } : {}),
        ...(error ? { error } : {}),
        ...(extraMeta ?? {}),
      },
    };
  }
}
