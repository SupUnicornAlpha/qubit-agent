/**
 * LlmRouter — M10.B1
 *
 * 把 `agent_definition.llmProvider` 字符串（如 "openai:gpt-4o" / "anthropic:claude-sonnet-4" /
 * "deepseek:deepseek-chat"）解析成 RuntimeModelConfig，并提供：
 *
 * - `resolveForAgent(def)`：按 def.llmProvider 路由到具体模型；失败时降级到默认模型
 * - `getDefault()`：从 `.qubit/model.json` 读默认/降级模型（保持向后兼容）
 * - `invokeWithFallback(...)`：包一层 gateway 调用 + try/catch 降级到 default model
 *
 * 关键设计：
 * - apiKey 来源优先级：DB(llm_provider_config) > env(`OPENAI_API_KEY` 等) > 空（→ 默认模型）
 * - DB providerType 用 "openai/anthropic/ollama/custom"，但 providerId 携带细分名（deepseek/qwen/zhipu）
 * - "custom" 在 runtime 通过 modelName 前缀推断 → deepseek/qwen/zhipu 走 OpenAI-compatible
 * - 全局 process.env fallback 保证用户不配 DB 也能跑（向后兼容）
 */

import { getDb } from "../../db/sqlite/client";
import { llmProviderConfig } from "../../db/sqlite/schema";
import { eq } from "drizzle-orm";
import { loadModelConfig, type RuntimeModelConfig } from "../config/model-config";
import { runLlmGateway, type LlmGatewayInput, type LlmTokenUsage } from "./gateway";

export type LlmProvider = RuntimeModelConfig["provider"];

const OPENAI_COMPATIBLE: LlmProvider[] = ["deepseek", "qwen", "zhipu"];

const KNOWN_PROVIDER_ALIASES: Record<string, LlmProvider> = {
  openai: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  ollama: "ollama",
  deepseek: "deepseek",
  qwen: "qwen",
  zhipu: "zhipu",
  glm: "zhipu",
  mock: "mock",
};

/** 把 modelName 推断到 runtime provider（兜底，用于 DB.providerType=custom 时） */
export function inferProviderFromModelName(modelName: string): LlmProvider {
  const m = modelName.toLowerCase();
  if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3")) return "openai";
  if (m.startsWith("claude")) return "anthropic";
  if (m.startsWith("llama") || m.startsWith("mistral") || m.startsWith("qwen2")) return "ollama";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen")) return "qwen";
  if (m.startsWith("glm")) return "zhipu";
  return "openai";
}

/** 解析 def.llmProvider 字符串："openai:gpt-4o" → { provider:'openai', model:'gpt-4o' } */
export function parseAgentLlmProviderString(raw: string | undefined | null): {
  provider: LlmProvider | null;
  model: string;
} {
  if (!raw || typeof raw !== "string") return { provider: null, model: "" };
  const trimmed = raw.trim();
  if (!trimmed) return { provider: null, model: "" };
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx < 0) {
    const alias = KNOWN_PROVIDER_ALIASES[trimmed.toLowerCase()];
    return { provider: alias ?? null, model: "" };
  }
  const head = trimmed.slice(0, colonIdx).toLowerCase();
  const tail = trimmed.slice(colonIdx + 1).trim();
  const provider = KNOWN_PROVIDER_ALIASES[head] ?? null;
  return { provider, model: tail };
}

/** 从 DB.llm_provider_config 按 providerId 查具体配置，转成 RuntimeModelConfig */
export async function loadProviderFromDb(
  providerId: string
): Promise<RuntimeModelConfig | null> {
  if (!providerId) return null;
  const db = await getDb();
  const rows = await db
    .select()
    .from(llmProviderConfig)
    .where(eq(llmProviderConfig.providerId, providerId))
    .limit(1);
  const row = rows[0];
  if (!row || !row.enabled) return null;

  const providerType: LlmProvider =
    row.providerType === "custom"
      ? inferProviderFromModelName(row.modelName)
      : (row.providerType as LlmProvider);

  // apiKeyRef 优先级：明文 apiKey > env(从 ref 解析) > 空
  // 当前阶段（B1 最小可用版）apiKeyRef 直接当 env 变量名读取；后续 P1 改 keychain
  const apiKey = row.apiKeyRef ? process.env[row.apiKeyRef] ?? row.apiKeyRef : "";

  const config: RuntimeModelConfig = {
    provider: providerType,
    model: row.modelName,
    apiKey,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
  };
  return config;
}

/**
 * 解析 Agent 应使用的模型配置：
 *
 * 优先级：
 * 1. def.llmProvider → 从 DB.llm_provider_config 查
 * 2. def.llmProvider → 把字符串本身当 RuntimeModelConfig（取 env apiKey）
 * 3. 全局默认 model.json
 * 4. mock
 */
export async function resolveLlmForAgent(def: {
  id?: string;
  role?: string;
  llmProvider?: string | null;
}): Promise<{ config: RuntimeModelConfig; source: "agent_db" | "agent_inline" | "default" | "mock" }> {
  const agentProvider = def.llmProvider ?? null;

  // 1. DB lookup
  if (agentProvider) {
    const fromDb = await loadProviderFromDb(agentProvider);
    if (fromDb && (fromDb.apiKey || fromDb.provider === "ollama" || fromDb.provider === "mock")) {
      return { config: fromDb, source: "agent_db" };
    }
    // 2. 字符串本身解析，apiKey 走 env
    const parsed = parseAgentLlmProviderString(agentProvider);
    if (parsed.provider && parsed.model) {
      const envKey = providerEnvKey(parsed.provider);
      const apiKey = envKey ? process.env[envKey] ?? "" : "";
      if (apiKey || parsed.provider === "ollama" || parsed.provider === "mock") {
        return {
          config: { provider: parsed.provider, model: parsed.model, apiKey },
          source: "agent_inline",
        };
      }
    }
  }

  // 3. 默认 model.json
  const def_ = await loadModelConfig();
  if (def_ && (def_.apiKey || def_.provider === "ollama" || def_.provider === "mock")) {
    return { config: def_, source: "default" };
  }

  // 4. mock 兜底
  return {
    config: { provider: "mock", model: "mock-reasoner", apiKey: "" },
    source: "mock",
  };
}

export function providerEnvKey(provider: LlmProvider): string | null {
  switch (provider) {
    case "openai":
      return "OPENAI_API_KEY";
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "deepseek":
      return "DEEPSEEK_API_KEY";
    case "qwen":
      return "DASHSCOPE_API_KEY";
    case "zhipu":
      return "ZHIPU_API_KEY";
    case "ollama":
    case "mock":
      return null;
    default:
      return null;
  }
}

/**
 * 带降级的 LLM 调用：
 *
 * 1. 用 primaryConfig（Agent 指定）跑 gateway
 * 2. 失败 → 拿 default model 再试一次（如果 default != primary）
 * 3. 都失败 → 抛错
 *
 * 返回 { answer, usage, latencyMs, modelUsed, fallbackUsed }
 */
export interface InvokeWithFallbackResult {
  answer: string;
  usage?: LlmTokenUsage;
  /** Gateway-measured latency of the actually-executed model call. */
  latencyMs: number;
  modelUsed: RuntimeModelConfig;
  fallbackUsed: boolean;
}

export async function invokeWithFallback(
  primaryConfig: RuntimeModelConfig,
  input: Omit<LlmGatewayInput, "config">
): Promise<InvokeWithFallbackResult> {
  try {
    const result = await runLlmGateway({ ...input, config: primaryConfig });
    return {
      answer: result.answer,
      ...(result.usage ? { usage: result.usage } : {}),
      latencyMs: result.latencyMs,
      modelUsed: primaryConfig,
      fallbackUsed: false,
    };
  } catch (err) {
    const defaultCfg = await loadModelConfig();
    // 没有 default 或 default == primary → 直接抛
    if (
      !defaultCfg ||
      (defaultCfg.provider === primaryConfig.provider && defaultCfg.model === primaryConfig.model)
    ) {
      throw err;
    }
    console.warn(
      `[LlmRouter] primary model failed (${primaryConfig.provider}:${primaryConfig.model}), ` +
        `falling back to default (${defaultCfg.provider}:${defaultCfg.model}): ` +
        (err instanceof Error ? err.message : String(err))
    );
    const result = await runLlmGateway({ ...input, config: defaultCfg });
    return {
      answer: result.answer,
      ...(result.usage ? { usage: result.usage } : {}),
      latencyMs: result.latencyMs,
      modelUsed: defaultCfg,
      fallbackUsed: true,
    };
  }
}

OPENAI_COMPATIBLE; // keep tree-shake hint
