import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Embedding 模型配置（挂在默认 model.json 上，供 Experience / Memory 向量化）。
 * apiKey / baseUrl 为空时运行时回退到顶层 chat 配置，再回退 OPENAI_API_KEY。
 */
export const EmbeddingModelConfigSchema = z.object({
  /** false 时工厂返回 null，走 keyword-only 等降级路径 */
  enabled: z.boolean().default(true),
  /** OpenAI-compatible embedding 模型名 */
  model: z.string().min(1).default("text-embedding-3-small"),
  /** 可选；空则复用顶层 baseUrl */
  baseUrl: z.string().optional(),
  /** 可选；空则复用顶层 apiKey / OPENAI_API_KEY */
  apiKey: z.string().default(""),
  /**
   * 可选输出维度（仅 text-embedding-3-* 等支持）。
   * 未设则按已知模型表推断（small=1536 / large=3072）。
   */
  dimensions: z.number().int().positive().optional(),
});

export type EmbeddingModelConfig = z.infer<typeof EmbeddingModelConfigSchema>;

const ModelConfigSchema = z.object({
  provider: z
    .enum(["openai", "anthropic", "ollama", "deepseek", "qwen", "zhipu", "mock"])
    .default("openai"),
  model: z.string().min(1).default("gpt-4o-mini"),
  apiKey: z.string().default(""),
  baseUrl: z.string().optional(),
  /** Optional explicit context window (tokens); used by reason budget when set. */
  contextWindow: z.number().int().positive().optional(),
  embedding: EmbeddingModelConfigSchema.optional(),
});

export type RuntimeModelConfig = z.infer<typeof ModelConfigSchema>;

function getModelConfigPath(rootDir = process.cwd()): string {
  return join(rootDir, ".qubit", "model.json");
}

function parseModelConfigRaw(raw: string): RuntimeModelConfig {
  return ModelConfigSchema.parse(JSON.parse(raw));
}

export async function loadModelConfig(rootDir = process.cwd()): Promise<RuntimeModelConfig | null> {
  const path = getModelConfigPath(rootDir);
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return parseModelConfigRaw(raw);
}

/** Sync loader for hot-path factories (embedding client) that cannot await. */
export function loadModelConfigSync(rootDir = process.cwd()): RuntimeModelConfig | null {
  const path = getModelConfigPath(rootDir);
  if (!existsSync(path)) return null;
  try {
    return parseModelConfigRaw(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export async function saveModelConfig(
  input: Partial<Omit<RuntimeModelConfig, "embedding">> & {
    embedding?: {
      enabled?: boolean;
      model?: string;
      apiKey?: string;
      /** `undefined` is an explicit request to clear the persisted optional value. */
      baseUrl?: string | undefined;
      dimensions?: number | undefined;
    } | null;
  },
  rootDir = process.cwd()
): Promise<RuntimeModelConfig> {
  const path = getModelConfigPath(rootDir);
  const dir = join(rootDir, ".qubit");
  await mkdir(dir, { recursive: true });
  const current = (await loadModelConfig(rootDir)) ?? ModelConfigSchema.parse({});

  let nextEmbedding: EmbeddingModelConfig | undefined = current.embedding;
  if (input.embedding === null) {
    nextEmbedding = undefined;
  } else if (input.embedding !== undefined) {
    const base = current.embedding ?? EmbeddingModelConfigSchema.parse({});
    const patch = input.embedding;
    const mergedApiKey =
      typeof patch.apiKey === "string" && patch.apiKey.trim()
        ? patch.apiKey.trim()
        : base.apiKey;
    const merged: Record<string, unknown> = {
      enabled: patch.enabled ?? base.enabled,
      model: patch.model ?? base.model,
      apiKey: mergedApiKey,
    };
    if ("baseUrl" in patch) {
      if (patch.baseUrl) merged.baseUrl = patch.baseUrl;
    } else if (base.baseUrl) {
      merged.baseUrl = base.baseUrl;
    }
    if ("dimensions" in patch) {
      if (typeof patch.dimensions === "number") merged.dimensions = patch.dimensions;
      // else: explicit clear — omit dimensions
    } else if (base.dimensions) {
      merged.dimensions = base.dimensions;
    }
    nextEmbedding = EmbeddingModelConfigSchema.parse(merged);
  }

  const { embedding: _drop, ...restInput } = input;
  const next = ModelConfigSchema.parse({
    ...current,
    ...restInput,
    ...(nextEmbedding !== undefined ? { embedding: nextEmbedding } : { embedding: undefined }),
  });

  // zod optional + explicit undefined: strip embedding key when cleared
  const toWrite: Record<string, unknown> = {
    provider: next.provider,
    model: next.model,
    apiKey: next.apiKey,
    ...(next.baseUrl !== undefined ? { baseUrl: next.baseUrl } : {}),
  };
  if (nextEmbedding !== undefined) {
    toWrite.embedding = {
      enabled: nextEmbedding.enabled,
      model: nextEmbedding.model,
      ...(nextEmbedding.baseUrl ? { baseUrl: nextEmbedding.baseUrl } : {}),
      ...(nextEmbedding.apiKey ? { apiKey: nextEmbedding.apiKey } : {}),
      ...(nextEmbedding.dimensions ? { dimensions: nextEmbedding.dimensions } : {}),
    };
  }

  await writeFile(path, JSON.stringify(toWrite, null, 2), "utf-8");
  return ModelConfigSchema.parse(toWrite);
}

/** Resolved credentials used by EmbeddingClient factory (never returns secrets to UI). */
export function resolveEmbeddingRuntimeOptions(
  config: RuntimeModelConfig | null,
  env: NodeJS.ProcessEnv = process.env
): {
  enabled: boolean;
  model: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  dimensions: number | undefined;
  source: "model.json" | "env" | "disabled" | "missing_credentials";
} {
  const emb = config?.embedding;
  if (emb?.enabled === false) {
    return {
      enabled: false,
      model: emb.model || "text-embedding-3-small",
      apiKey: undefined,
      baseURL: undefined,
      dimensions: emb.dimensions,
      source: "disabled",
    };
  }

  const model = emb?.model?.trim() || "text-embedding-3-small";
  const apiKey =
    emb?.apiKey?.trim() ||
    config?.apiKey?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    undefined;
  const baseURL = emb?.baseUrl?.trim() || config?.baseUrl?.trim() || undefined;
  const dimensions = emb?.dimensions;

  if (!apiKey) {
    return {
      enabled: true,
      model,
      apiKey: undefined,
      baseURL,
      dimensions,
      source: "missing_credentials",
    };
  }

  const fromConfigKey = Boolean(emb?.apiKey?.trim() || config?.apiKey?.trim());
  return {
    enabled: true,
    model,
    apiKey,
    baseURL,
    dimensions,
    source: fromConfigKey ? "model.json" : "env",
  };
}
