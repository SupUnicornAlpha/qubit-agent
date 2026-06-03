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
 * P2 智能重试（length-retry）：
 *   - 单次成功但 finishReason ∈ { length, max_output_tokens, incomplete } → 截断信号
 *   - 把 maxOutputTokens × 2（上限 32768），用同一 model 重试**最多一次**；
 *     补救成功（新 finishReason ≠ 截断 / 内容更长）就用新答案
 *   - content_filter / 其它非截断信号不重试
 *   - ENV `QUBIT_LLM_LENGTH_RETRY_DISABLED=1` 关闭整条机制（debug / 老代理）
 *
 * 返回 { answer, usage, latencyMs, modelUsed, fallbackUsed, lengthRetryUsed }
 */
export interface InvokeWithFallbackResult {
  answer: string;
  usage?: LlmTokenUsage;
  /** Gateway-measured latency of the actually-executed model call. */
  latencyMs: number;
  /** Streaming 首 token 延迟（非流式 = latencyMs）；缺信息时不写。 */
  firstTokenLatencyMs?: number;
  /** 服务端 response id，跨日志追溯用。 */
  responseId?: string;
  /** finish_reason / stop_reason / done_reason 字面量。 */
  finishReason?: string;
  modelUsed: RuntimeModelConfig;
  fallbackUsed: boolean;
  /** P2：本次调用是否被 length-retry 自救过（即 max_tokens 翻倍重试一次）。 */
  lengthRetryUsed: boolean;
}

/** length-retry 的 max_tokens 硬上限：避免误读 finishReason 让单次调用炸到天文数字。 */
const LENGTH_RETRY_MAX_TOKENS_CAP = 32_768;
/** 截断信号：触发自动 length-retry。涵盖 OpenAI / Anthropic / Responses 三套语义。 */
const TRUNCATION_FINISH_REASONS: ReadonlySet<string> = new Set([
  "length",
  "max_tokens",
  "max_output_tokens",
  "incomplete",
]);

function isTruncated(finishReason: string | undefined): boolean {
  if (!finishReason) return false;
  return TRUNCATION_FINISH_REASONS.has(finishReason.toLowerCase());
}

/** 把 LlmGatewayResult 投影成 InvokeWithFallbackResult 的公共字段（兼顾 exactOptional）。 */
function projectResult(
  result: Awaited<ReturnType<typeof runLlmGateway>>,
  modelUsed: RuntimeModelConfig,
  flags: { fallbackUsed: boolean; lengthRetryUsed: boolean },
): InvokeWithFallbackResult {
  return {
    answer: result.answer,
    ...(result.usage ? { usage: result.usage } : {}),
    latencyMs: result.latencyMs,
    ...(result.firstTokenLatencyMs !== undefined
      ? { firstTokenLatencyMs: result.firstTokenLatencyMs }
      : {}),
    ...(result.responseId ? { responseId: result.responseId } : {}),
    ...(result.finishReason ? { finishReason: result.finishReason } : {}),
    modelUsed,
    fallbackUsed: flags.fallbackUsed,
    lengthRetryUsed: flags.lengthRetryUsed,
  };
}

/**
 * 内部：跑一次 gateway；如果触发截断信号且允许重试，加大 maxOutputTokens 再跑一次，
 * 并合并 usage / latencyMs。把"length-retry 是否发生"通过返回值告诉外层。
 */
async function invokeOnceWithLengthRetry(
  config: RuntimeModelConfig,
  input: Omit<LlmGatewayInput, "config">,
): Promise<{
  result: Awaited<ReturnType<typeof runLlmGateway>>;
  lengthRetryUsed: boolean;
}> {
  const first = await runLlmGateway({ ...input, config });
  if (process.env["QUBIT_LLM_LENGTH_RETRY_DISABLED"] === "1") {
    return { result: first, lengthRetryUsed: false };
  }
  if (!isTruncated(first.finishReason)) {
    return { result: first, lengthRetryUsed: false };
  }
  /**
   * 计算下一次 maxOutputTokens：原 sampling 没指定就以 4096 起步（与
   * gateway 内置默认对齐）；上限 32768 防失控。
   */
  const prevMax = input.sampling?.maxOutputTokens ?? 4096;
  if (prevMax >= LENGTH_RETRY_MAX_TOKENS_CAP) {
    return { result: first, lengthRetryUsed: false };
  }
  const nextMax = Math.min(LENGTH_RETRY_MAX_TOKENS_CAP, Math.max(prevMax * 2, prevMax + 1024));
  console.warn(
    `[LlmRouter] truncated finishReason=${first.finishReason} ` +
      `(${config.provider}:${config.model}) → length-retry maxOutputTokens ${prevMax} → ${nextMax}`,
  );
  let second: Awaited<ReturnType<typeof runLlmGateway>>;
  try {
    second = await runLlmGateway({
      ...input,
      sampling: { ...(input.sampling ?? {}), maxOutputTokens: nextMax },
      config,
    });
  } catch (err) {
    /**
     * length-retry 自身失败不应该让原本"成功但截断"的结果丢失 — 把首次
     * 结果当作可用答案返回，由 caller 自己决定怎么处理截断。
     */
    console.warn(
      `[LlmRouter] length-retry threw (${(err as Error).message}); keeping first truncated result`,
    );
    return { result: first, lengthRetryUsed: false };
  }
  /**
   * 合并 usage / latency。retry 的 firstTokenLatencyMs **不**覆盖 first：caller 视
   * 角第一次 token 进来的时间才是真正的 TTFT；retry 是网关层补救，对体验透明。
   */
  const merged: Awaited<ReturnType<typeof runLlmGateway>> = {
    answer: second.answer || first.answer,
    latencyMs: first.latencyMs + second.latencyMs,
    ...(first.firstTokenLatencyMs !== undefined
      ? { firstTokenLatencyMs: first.firstTokenLatencyMs }
      : second.firstTokenLatencyMs !== undefined
        ? { firstTokenLatencyMs: second.firstTokenLatencyMs }
        : {}),
    ...(second.responseId ? { responseId: second.responseId } : first.responseId ? { responseId: first.responseId } : {}),
    ...(second.finishReason ? { finishReason: second.finishReason } : {}),
    ...(mergeUsage(first.usage, second.usage) ? { usage: mergeUsage(first.usage, second.usage)! } : {}),
  };
  return { result: merged, lengthRetryUsed: true };
}

function mergeUsage(
  a: LlmTokenUsage | undefined,
  b: LlmTokenUsage | undefined,
): LlmTokenUsage | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const promptTokens = sum(a.promptTokens, b.promptTokens);
  const completionTokens = sum(a.completionTokens, b.completionTokens);
  const totalTokens = sum(a.totalTokens, b.totalTokens);
  const cachedPromptTokens = sum(a.cachedPromptTokens, b.cachedPromptTokens);
  const reasoningTokens = sum(a.reasoningTokens, b.reasoningTokens);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export async function invokeWithFallback(
  primaryConfig: RuntimeModelConfig,
  input: Omit<LlmGatewayInput, "config">
): Promise<InvokeWithFallbackResult> {
  try {
    const { result, lengthRetryUsed } = await invokeOnceWithLengthRetry(primaryConfig, input);
    return projectResult(result, primaryConfig, { fallbackUsed: false, lengthRetryUsed });
  } catch (err) {
    const defaultCfg = await loadModelConfig();
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
    const { result, lengthRetryUsed } = await invokeOnceWithLengthRetry(defaultCfg, input);
    return projectResult(result, defaultCfg, { fallbackUsed: true, lengthRetryUsed });
  }
}

OPENAI_COMPATIBLE; // keep tree-shake hint
