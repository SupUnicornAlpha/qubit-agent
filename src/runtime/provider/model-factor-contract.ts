/**
 * Model-factor 对接契约（P0）
 *
 * 外部训练平台 / 实时打分服务只需实现 `ModelFactorAdapter.infer`，
 * 或走内置 `http` adapter 的 JSON 协议。QUBIT 侧把推理结果视为普通因子值
 * （symbol × date × value），复用 factor.compute / autoEvaluate / promote。
 *
 * 本模块只定义协议与校验；不实现任何具体训练循环。
 */

import type { BacktestDataset, FactorComputeRow } from "./types";

export const MODEL_FACTOR_PROTOCOL_VERSION = "model-factor-infer-v1" as const;

export type ModelFactorScoreTransform = "raw" | "rank" | "zscore";

/**
 * 冻结在 factor_definition.definition_json.modelFactor 里的绑定。
 * Agent / REST 发布模型因子时写入；compute 时原样交给 adapter。
 */
export interface ModelFactorBinding {
  protocolVersion: typeof MODEL_FACTOR_PROTOCOL_VERSION;
  /** 已注册的 adapter key；内置 `http` 走 HTTP JSON 协议。 */
  adapterKey: string;
  modelId: string;
  modelVersion: string;
  /** 可选：权重/产物 URI（file://、s3://、自定义 scheme） */
  artifactUri?: string;
  contentHash?: string;
  framework?: string;
  featureSpecId?: string;
  /** 训练截止 as-of（YYYY-MM-DD）；推理日不得用此后才可得的标签逻辑由外部保证 */
  trainEndAsOf?: string;
  scoreTransform?: ModelFactorScoreTransform;
  /**
   * adapter 私有配置。`http` adapter 认这些字段：
   *   endpoint (string, required)
   *   headers (Record<string,string>)
   *   timeoutMs (number)
   *   includeBars (boolean, default true when dataset is bound)
   */
  adapterConfig?: Record<string, unknown>;
}

export interface ModelFactorInferRequest {
  protocolVersion: typeof MODEL_FACTOR_PROTOCOL_VERSION;
  requestId: string;
  binding: ModelFactorBinding;
  factorId?: string;
  universe: string;
  symbols: string[];
  startDate: string;
  endDate: string;
  /** 绑定不可变快照时必填；adapter 不得另拉「今日行情」。 */
  datasetSnapshotId?: string;
  dataset?: BacktestDataset;
  asOf?: string;
}

export interface ModelFactorInferResult {
  ok: boolean;
  rows?: FactorComputeRow[];
  error?: string;
  meta?: Record<string, unknown>;
}

/**
 * 外部平台接入点。进程内 `registerModelFactorAdapter` 注册后即可被
 * `external_ml` FactorComputeProvider 调度。
 */
export interface ModelFactorAdapter {
  readonly key: string;
  readonly displayName?: string;
  readonly description?: string;
  healthCheck?(): Promise<{ ok: boolean; error?: string }>;
  infer(request: ModelFactorInferRequest): Promise<ModelFactorInferResult>;
}

export class ModelFactorContractError extends Error {
  constructor(
    public code: "invalid_binding" | "adapter_missing" | "infer_failed",
    message: string,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "ModelFactorContractError";
  }
}

export function buildModelFactorExpr(binding: Pick<ModelFactorBinding, "adapterKey" | "modelId" | "modelVersion">): string {
  const version = binding.modelVersion.trim() || "0";
  return `model://${binding.adapterKey.trim()}/${binding.modelId.trim()}@${version}`;
}

export function parseModelFactorBinding(raw: unknown): ModelFactorBinding {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ModelFactorContractError("invalid_binding", "modelFactor must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const adapterKey = String(obj.adapterKey ?? obj.adapter_key ?? "").trim();
  const modelId = String(obj.modelId ?? obj.model_id ?? "").trim();
  const modelVersion = String(obj.modelVersion ?? obj.model_version ?? "").trim();
  if (!adapterKey) {
    throw new ModelFactorContractError("invalid_binding", "modelFactor.adapterKey is required");
  }
  if (!modelId) {
    throw new ModelFactorContractError("invalid_binding", "modelFactor.modelId is required");
  }
  if (!modelVersion) {
    throw new ModelFactorContractError("invalid_binding", "modelFactor.modelVersion is required");
  }

  const scoreTransformRaw = obj.scoreTransform ?? obj.score_transform;
  let scoreTransform: ModelFactorScoreTransform | undefined;
  if (scoreTransformRaw !== undefined && scoreTransformRaw !== null && String(scoreTransformRaw).trim()) {
    const t = String(scoreTransformRaw).trim() as ModelFactorScoreTransform;
    if (t !== "raw" && t !== "rank" && t !== "zscore") {
      throw new ModelFactorContractError(
        "invalid_binding",
        `modelFactor.scoreTransform must be raw|rank|zscore; got ${t}`
      );
    }
    scoreTransform = t;
  }

  const adapterConfigRaw = obj.adapterConfig ?? obj.adapter_config;
  const adapterConfig =
    adapterConfigRaw && typeof adapterConfigRaw === "object" && !Array.isArray(adapterConfigRaw)
      ? (adapterConfigRaw as Record<string, unknown>)
      : undefined;

  const optionalText = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  return {
    protocolVersion: MODEL_FACTOR_PROTOCOL_VERSION,
    adapterKey,
    modelId,
    modelVersion,
    ...(optionalText("artifactUri", "artifact_uri")
      ? { artifactUri: optionalText("artifactUri", "artifact_uri") }
      : {}),
    ...(optionalText("contentHash", "content_hash")
      ? { contentHash: optionalText("contentHash", "content_hash") }
      : {}),
    ...(optionalText("framework") ? { framework: optionalText("framework") } : {}),
    ...(optionalText("featureSpecId", "feature_spec_id")
      ? { featureSpecId: optionalText("featureSpecId", "feature_spec_id") }
      : {}),
    ...(optionalText("trainEndAsOf", "train_end_as_of")
      ? { trainEndAsOf: optionalText("trainEndAsOf", "train_end_as_of") }
      : {}),
    ...(scoreTransform ? { scoreTransform } : {}),
    ...(adapterConfig ? { adapterConfig } : {}),
  };
}

/** 从 factor.definition_json 取出并校验 modelFactor。 */
export function extractModelFactorBinding(
  definition: Record<string, unknown> | null | undefined
): ModelFactorBinding | null {
  if (!definition) return null;
  const raw = definition.modelFactor ?? definition.model_factor;
  if (raw === undefined || raw === null) return null;
  return parseModelFactorBinding(raw);
}

export function compactDatasetForInfer(
  dataset: BacktestDataset | undefined,
  includeBars: boolean
): {
  datasetSnapshotId?: string;
  dataRef?: string;
  asOf?: string;
  timeframe?: string;
  barsBySymbol?: BacktestDataset["barsBySymbol"];
} {
  if (!dataset) return {};
  return {
    datasetSnapshotId: dataset.snapshotId,
    dataRef: dataset.dataRef,
    asOf: dataset.asOf,
    timeframe: dataset.timeframe,
    ...(includeBars ? { barsBySymbol: dataset.barsBySymbol } : {}),
  };
}
