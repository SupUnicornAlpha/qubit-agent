/**
 * 内置 HTTP ModelFactorAdapter
 *
 * 外部训练 / 实时打分平台只需暴露一个 JSON 端点：
 *   POST binding.adapterConfig.endpoint
 *   body  = ModelFactorInferRequest 的可序列化形态（含可选 bars）
 *   reply = { ok, rows?: [{symbol,date,value}], error?, meta? }
 */

import { randomUUID } from "node:crypto";
import {
  MODEL_FACTOR_PROTOCOL_VERSION,
  type ModelFactorAdapter,
  type ModelFactorInferRequest,
  type ModelFactorInferResult,
  compactDatasetForInfer,
} from "../../model-factor-contract";

type HttpAdapterConfig = {
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  includeBars?: boolean;
};

function readHttpConfig(request: ModelFactorInferRequest): HttpAdapterConfig {
  const cfg = request.binding.adapterConfig ?? {};
  const endpoint = String(cfg.endpoint ?? cfg.url ?? "").trim();
  if (!endpoint) {
    throw new Error("http adapter requires adapterConfig.endpoint");
  }
  const headersRaw = cfg.headers;
  const headers =
    headersRaw && typeof headersRaw === "object" && !Array.isArray(headersRaw)
      ? Object.fromEntries(
          Object.entries(headersRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        )
      : undefined;
  const timeoutMs = cfg.timeoutMs !== undefined ? Number(cfg.timeoutMs) : undefined;
  const includeBars =
    cfg.includeBars === undefined && cfg.include_bars === undefined
      ? true
      : Boolean(cfg.includeBars ?? cfg.include_bars);
  return {
    endpoint,
    ...(headers ? { headers } : {}),
    ...(timeoutMs !== undefined && Number.isFinite(timeoutMs) ? { timeoutMs } : {}),
    includeBars,
  };
}

export function createHttpModelFactorAdapter(): ModelFactorAdapter {
  return {
    key: "http",
    displayName: "HTTP JSON model-factor bridge",
    description:
      "POST sealed infer requests to adapterConfig.endpoint; external platforms return symbol×date scores.",
    async healthCheck() {
      return { ok: true };
    },
    async infer(request: ModelFactorInferRequest): Promise<ModelFactorInferResult> {
      let cfg: HttpAdapterConfig;
      try {
        cfg = readHttpConfig(request);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }

      const datasetPayload = compactDatasetForInfer(request.dataset, cfg.includeBars !== false);
      const body = {
        protocolVersion: MODEL_FACTOR_PROTOCOL_VERSION,
        requestId: request.requestId || randomUUID(),
        model: {
          modelId: request.binding.modelId,
          modelVersion: request.binding.modelVersion,
          ...(request.binding.artifactUri ? { artifactUri: request.binding.artifactUri } : {}),
          ...(request.binding.contentHash ? { contentHash: request.binding.contentHash } : {}),
          ...(request.binding.framework ? { framework: request.binding.framework } : {}),
          ...(request.binding.featureSpecId ? { featureSpecId: request.binding.featureSpecId } : {}),
          ...(request.binding.trainEndAsOf ? { trainEndAsOf: request.binding.trainEndAsOf } : {}),
          ...(request.binding.scoreTransform
            ? { scoreTransform: request.binding.scoreTransform }
            : {}),
        },
        factorId: request.factorId,
        universe: request.universe,
        symbols: request.symbols,
        startDate: request.startDate,
        endDate: request.endDate,
        asOf: request.asOf ?? datasetPayload.asOf,
        ...datasetPayload,
      };

      const controller = new AbortController();
      const timeoutMs = cfg.timeoutMs ?? 60_000;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(cfg.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(cfg.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const text = await resp.text();
        let parsed: Record<string, unknown>;
        try {
          parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        } catch {
          return {
            ok: false,
            error: `http_adapter_invalid_json: status=${resp.status}`,
            meta: { status: resp.status, bodyPreview: text.slice(0, 500) },
          };
        }
        if (!resp.ok) {
          return {
            ok: false,
            error: String(parsed.error ?? `http_adapter_http_${resp.status}`),
            meta: { status: resp.status, ...(parsed.meta as object | undefined) },
          };
        }
        if (parsed.ok === false) {
          return {
            ok: false,
            error: String(parsed.error ?? "http_adapter_remote_ok_false"),
            meta: (parsed.meta as Record<string, unknown> | undefined) ?? undefined,
          };
        }
        const rowsRaw = parsed.rows;
        if (!Array.isArray(rowsRaw)) {
          return { ok: false, error: "http_adapter_rows_missing" };
        }
        const rows = rowsRaw
          .map((row) => {
            if (!row || typeof row !== "object") return null;
            const r = row as Record<string, unknown>;
            const symbol = String(r.symbol ?? "").trim();
            const date = String(r.date ?? "").trim().slice(0, 10);
            const valueRaw = r.value;
            const value =
              valueRaw === null || valueRaw === undefined
                ? null
                : Number(valueRaw);
            if (!symbol || !date) return null;
            return {
              symbol,
              date,
              value: value === null || Number.isFinite(value) ? value : null,
            };
          })
          .filter((r): r is { symbol: string; date: string; value: number | null } => r !== null);

        return {
          ok: true,
          rows,
          meta: {
            adapter: "http",
            endpoint: cfg.endpoint,
            status: resp.status,
            ...((parsed.meta as Record<string, unknown> | undefined) ?? {}),
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          error: msg.includes("abort") ? `http_adapter_timeout:${timeoutMs}ms` : msg,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
