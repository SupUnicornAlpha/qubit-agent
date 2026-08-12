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

import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { llmProviderConfig } from "../../db/sqlite/schema";
import { type RuntimeModelConfig, loadModelConfig } from "../config/model-config";
import { type LlmGatewayInput, type LlmTokenUsage, runLlmGateway } from "./gateway";
import {
  LlmGatewayError,
  type LlmGatewayErrorJson,
  classifyLlmGatewayError,
  isFallbackEligibleLlmGatewayError,
  isRetryableLlmGatewayError,
} from "./llm-gateway-error";

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
export async function loadProviderFromDb(providerId: string): Promise<RuntimeModelConfig | null> {
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

  /**
   * apiKey 取值优先级（2026-06-05 修复"重启后缺 apiKey"后）：
   *   1. `row.apiKeySecret`：migration 0079 起，明文 apiKey 持久化在此列，重启不丢
   *   2. `process.env[row.apiKeyRef]`：兼容旧数据 / user 自己用 env 引用方式配置的情况
   *   3. 空串 → 上层会降级到 default model
   *
   * 注意：旧实现里的 `process.env[row.apiKeyRef] ?? row.apiKeyRef` 是 bug —— env 不存在时
   * 会把 envKey 的字符串名字（如 "OPENAI_API_KEY"）当作真正的 apiKey 调下游 LLM，鉴权一定
   * 失败且错误信息高度误导（看起来像"key 错了"，实际是这里读串了）。这里改为兜底空串。
   */
  const apiKey =
    (row.apiKeySecret && row.apiKeySecret.length > 0
      ? row.apiKeySecret
      : row.apiKeyRef
        ? (process.env[row.apiKeyRef] ?? "")
        : "") ?? "";

  const config: RuntimeModelConfig = {
    provider: providerType,
    model: row.modelName,
    apiKey,
    ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
    ...(typeof row.contextWindow === "number" &&
    Number.isFinite(row.contextWindow) &&
    row.contextWindow > 0
      ? { contextWindow: row.contextWindow }
      : {}),
  };
  return config;
}

/**
 * 启动期把 DB 中所有 `api_key_secret` 还原到 `process.env[apiKeyRef]`。
 *
 * 必要性：除了 `loadProviderFromDb` 已经能直接读 `apiKeySecret` 外，仍有路径
 * （如 inline-string 路径中 `process.env[envKey]`、或者用户直接 fetch
 * OpenAI/Anthropic SDK 时读 `process.env.OPENAI_API_KEY`）依赖 env。把 secret
 * hydrate 回 env 能在不动这些消费者的前提下消除"重启即丢"的体感问题。
 *
 * 仅在 `apiKeyRef && apiKeySecret` 同时存在时写入；如果 env 已被 OS 层（shell
 * export / .env）注入了同名变量，**不覆盖**——避免 DB 里的旧值打掉 user 通过环境
 * 变量临时覆盖的新值。
 */
export async function hydrateLlmProviderEnv(): Promise<{
  scanned: number;
  hydrated: number;
  skippedExistingEnv: number;
}> {
  const db = await getDb();
  const rows = await db.select().from(llmProviderConfig);
  let hydrated = 0;
  let skippedExistingEnv = 0;
  for (const row of rows) {
    if (!row.apiKeyRef || !row.apiKeySecret) continue;
    if (process.env[row.apiKeyRef] && process.env[row.apiKeyRef] !== "") {
      skippedExistingEnv += 1;
      continue;
    }
    process.env[row.apiKeyRef] = row.apiKeySecret;
    hydrated += 1;
  }
  return { scanned: rows.length, hydrated, skippedExistingEnv };
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
}): Promise<{
  config: RuntimeModelConfig;
  source: "agent_db" | "agent_inline" | "default" | "mock";
}> {
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
      const apiKey = envKey ? (process.env[envKey] ?? "") : "";
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
  /**
   * P3-3：模型本轮主动请求调用的工具列表（基础设施透传；caller 可不读）。
   * 仅当 caller 通过 LlmGatewayInput.tools 启用了原生 tool calling、且模型返回了
   * function_call / tool_use blocks 时存在。
   */
  toolCalls?: import("./gateway").LlmToolCallRequest[];
  modelUsed: RuntimeModelConfig;
  fallbackUsed: boolean;
  /** P2：本次调用是否被 length-retry 自救过（即 max_tokens 翻倍重试一次）。 */
  lengthRetryUsed: boolean;
  /** Observability: transport/provider retries consumed on the winning model path. */
  transportAttempts?: number;
  /** Observability: last structured gateway error seen before success/fallback/throw. */
  lastError?: LlmGatewayErrorJson;
}

/** length-retry 的 max_tokens 硬上限：避免误读 finishReason 让单次调用炸到天文数字。 */
const LENGTH_RETRY_MAX_TOKENS_CAP = 32_768;
const TRANSPORT_RETRY_ATTEMPTS = 4;
/** Base delay for 503/network retries: 1s, 2s, 4s… */
const TRANSPORT_RETRY_BASE_MS = 1_000;
const TRANSPORT_RETRY_MAX_MS = 8_000;
/** When provider circuit is open, wait this long once before a final attempt. */
const CIRCUIT_OPEN_WAIT_MS = 21_000;
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

/**
 * A provider socket reset is transient infrastructure failure, not an agent
 * decision.  Retrying here keeps the reason node from turning a one-off fetch
 * reset into a user-visible "LLM gateway error" final answer.
 *
 * Prefer structured classification; regex kept only for pre-structured callers.
 */
export function isRetryableTransportError(error: unknown): boolean {
  return isRetryableLlmGatewayError(error);
}

/** @deprecated use classifyLlmGatewayError(error).code === "CIRCUIT_OPEN" */
export function isCircuitOpenError(error: unknown): boolean {
  return classifyLlmGatewayError(error).code === "CIRCUIT_OPEN";
}

function transportRetryDelayMs(attempt: number, error: unknown): number {
  const classified = classifyLlmGatewayError(error);
  if (classified.retryAfterMs !== undefined && classified.retryAfterMs > 0) {
    return Math.min(CIRCUIT_OPEN_WAIT_MS, classified.retryAfterMs);
  }
  if (classified.code === "CIRCUIT_OPEN") return CIRCUIT_OPEN_WAIT_MS;
  if (classified.code === "RATE_LIMIT") {
    return Math.min(TRANSPORT_RETRY_MAX_MS, TRANSPORT_RETRY_BASE_MS * 2 ** attempt);
  }
  const exp = Math.min(TRANSPORT_RETRY_MAX_MS, TRANSPORT_RETRY_BASE_MS * 2 ** (attempt - 1));
  return exp;
}

function logGatewayEvent(
  event: string,
  fields: Record<string, string | number | boolean | undefined | null>
): void {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(" ");
  console.warn(`[LlmRouter] ${event}${body ? ` ${body}` : ""}`);
}

async function runGatewayWithTransportRetry(
  config: RuntimeModelConfig,
  input: Omit<LlmGatewayInput, "config">
): Promise<{
  result: Awaited<ReturnType<typeof runLlmGateway>>;
  transportAttempts: number;
  lastError?: LlmGatewayErrorJson;
}> {
  const retryEnabled = process.env.QUBIT_LLM_TRANSPORT_RETRY_DISABLED !== "1";
  let lastError: unknown;
  let lastJson: LlmGatewayErrorJson | undefined;
  for (let attempt = 1; attempt <= TRANSPORT_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const result = await runLlmGateway({ ...input, config });
      return {
        result,
        transportAttempts: attempt,
        ...(lastJson ? { lastError: lastJson } : {}),
      };
    } catch (error) {
      lastError = error;
      const classified = classifyLlmGatewayError(error, {
        provider: config.provider,
        model: config.model,
        attempt,
      });
      lastJson = classified.toJSON();
      const mayRetry =
        retryEnabled &&
        !input.signal?.aborted &&
        attempt < TRANSPORT_RETRY_ATTEMPTS &&
        classified.retryable;
      if (!mayRetry) {
        throw classified;
      }
      const delayMs = transportRetryDelayMs(attempt, classified);
      logGatewayEvent("transport_retry", {
        provider: config.provider,
        model: config.model,
        code: classified.code,
        attempt: `${attempt + 1}/${TRANSPORT_RETRY_ATTEMPTS}`,
        delayMs,
        message: classified.message.slice(0, 180),
      });
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw classifyLlmGatewayError(lastError ?? new Error("unreachable: transport retry exhausted"), {
    provider: config.provider,
    model: config.model,
  });
}

/** 把 LlmGatewayResult 投影成 InvokeWithFallbackResult 的公共字段（兼顾 exactOptional）。 */
function projectResult(
  result: Awaited<ReturnType<typeof runLlmGateway>>,
  modelUsed: RuntimeModelConfig,
  flags: {
    fallbackUsed: boolean;
    lengthRetryUsed: boolean;
    transportAttempts?: number;
    lastError?: LlmGatewayErrorJson;
  }
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
    ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    modelUsed,
    fallbackUsed: flags.fallbackUsed,
    lengthRetryUsed: flags.lengthRetryUsed,
    ...(flags.transportAttempts !== undefined
      ? { transportAttempts: flags.transportAttempts }
      : {}),
    ...(flags.lastError ? { lastError: flags.lastError } : {}),
  };
}

/**
 * 内部：跑一次 gateway；如果触发截断信号且允许重试，加大 maxOutputTokens 再跑一次，
 * 并合并 usage / latencyMs。把"length-retry 是否发生"通过返回值告诉外层。
 */
async function invokeOnceWithLengthRetry(
  config: RuntimeModelConfig,
  input: Omit<LlmGatewayInput, "config">
): Promise<{
  result: Awaited<ReturnType<typeof runLlmGateway>>;
  lengthRetryUsed: boolean;
  transportAttempts: number;
  lastError?: LlmGatewayErrorJson;
}> {
  const firstAttempt = await runGatewayWithTransportRetry(config, input);
  const first = firstAttempt.result;
  if (process.env.QUBIT_LLM_LENGTH_RETRY_DISABLED === "1") {
    return {
      result: first,
      lengthRetryUsed: false,
      transportAttempts: firstAttempt.transportAttempts,
      ...(firstAttempt.lastError ? { lastError: firstAttempt.lastError } : {}),
    };
  }
  if (!isTruncated(first.finishReason)) {
    return {
      result: first,
      lengthRetryUsed: false,
      transportAttempts: firstAttempt.transportAttempts,
      ...(firstAttempt.lastError ? { lastError: firstAttempt.lastError } : {}),
    };
  }
  /**
   * 计算下一次 maxOutputTokens：原 sampling 没指定就以 4096 起步（与
   * gateway 内置默认对齐）；上限 32768 防失控。
   */
  const prevMax = input.sampling?.maxOutputTokens ?? 4096;
  if (prevMax >= LENGTH_RETRY_MAX_TOKENS_CAP) {
    return {
      result: first,
      lengthRetryUsed: false,
      transportAttempts: firstAttempt.transportAttempts,
      ...(firstAttempt.lastError ? { lastError: firstAttempt.lastError } : {}),
    };
  }
  const nextMax = Math.min(LENGTH_RETRY_MAX_TOKENS_CAP, Math.max(prevMax * 2, prevMax + 1024));
  logGatewayEvent("length_retry", {
    provider: config.provider,
    model: config.model,
    finishReason: first.finishReason,
    prevMax,
    nextMax,
  });
  let secondAttempt: Awaited<ReturnType<typeof runGatewayWithTransportRetry>>;
  try {
    secondAttempt = await runGatewayWithTransportRetry(config, {
      ...input,
      sampling: { ...(input.sampling ?? {}), maxOutputTokens: nextMax },
    });
  } catch (err) {
    if (input.signal?.aborted) throw err;
    /**
     * length-retry 自身失败不应该让原本"成功但截断"的结果丢失 — 把首次
     * 结果当作可用答案返回，由 caller 自己决定怎么处理截断。
     */
    const classified = classifyLlmGatewayError(err, {
      provider: config.provider,
      model: config.model,
    });
    logGatewayEvent("length_retry_failed", {
      provider: config.provider,
      model: config.model,
      code: classified.code,
      message: classified.message.slice(0, 180),
    });
    return {
      result: first,
      lengthRetryUsed: false,
      transportAttempts: firstAttempt.transportAttempts,
      lastError: classified.toJSON(),
    };
  }
  const second = secondAttempt.result;
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
    ...(second.responseId
      ? { responseId: second.responseId }
      : first.responseId
        ? { responseId: first.responseId }
        : {}),
    ...(second.finishReason ? { finishReason: second.finishReason } : {}),
    ...(mergeUsage(first.usage, second.usage)
      ? { usage: mergeUsage(first.usage, second.usage)! }
      : {}),
  };
  return {
    result: merged,
    lengthRetryUsed: true,
    transportAttempts: firstAttempt.transportAttempts + secondAttempt.transportAttempts,
    ...(secondAttempt.lastError
      ? { lastError: secondAttempt.lastError }
      : firstAttempt.lastError
        ? { lastError: firstAttempt.lastError }
        : {}),
  };
}

function mergeUsage(
  a: LlmTokenUsage | undefined,
  b: LlmTokenUsage | undefined
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
  const cacheCreationInputTokens = sum(a.cacheCreationInputTokens, b.cacheCreationInputTokens);
  const reasoningTokens = sum(a.reasoningTokens, b.reasoningTokens);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export async function invokeWithFallback(
  primaryConfig: RuntimeModelConfig,
  input: Omit<LlmGatewayInput, "config">
): Promise<InvokeWithFallbackResult> {
  try {
    const { result, lengthRetryUsed, transportAttempts, lastError } =
      await invokeOnceWithLengthRetry(primaryConfig, input);
    return projectResult(result, primaryConfig, {
      fallbackUsed: false,
      lengthRetryUsed,
      transportAttempts,
      ...(lastError ? { lastError } : {}),
    });
  } catch (err) {
    // 用户停止不应触发模型 fallback；否则会在另一个 provider 上继续生成/计费。
    if (input.signal?.aborted) throw err;
    const classified = classifyLlmGatewayError(err, {
      provider: primaryConfig.provider,
      model: primaryConfig.model,
    });
    if (!isFallbackEligibleLlmGatewayError(classified)) {
      logGatewayEvent("fallback_skipped", {
        provider: primaryConfig.provider,
        model: primaryConfig.model,
        code: classified.code,
        reason: "not_fallback_eligible",
      });
      throw classified;
    }
    const defaultCfg = await loadModelConfig();
    if (
      !defaultCfg ||
      (defaultCfg.provider === primaryConfig.provider && defaultCfg.model === primaryConfig.model)
    ) {
      throw classified;
    }
    logGatewayEvent("fallback", {
      from: `${primaryConfig.provider}:${primaryConfig.model}`,
      to: `${defaultCfg.provider}:${defaultCfg.model}`,
      code: classified.code,
      message: classified.message.slice(0, 180),
    });
    try {
      const { result, lengthRetryUsed, transportAttempts, lastError } =
        await invokeOnceWithLengthRetry(defaultCfg, input);
      return projectResult(result, defaultCfg, {
        fallbackUsed: true,
        lengthRetryUsed,
        transportAttempts,
        lastError: lastError ?? classified.toJSON(),
      });
    } catch (fallbackErr) {
      const fallbackClassified = classifyLlmGatewayError(fallbackErr, {
        provider: defaultCfg.provider,
        model: defaultCfg.model,
      });
      logGatewayEvent("fallback_failed", {
        provider: defaultCfg.provider,
        model: defaultCfg.model,
        code: fallbackClassified.code,
        primaryCode: classified.code,
      });
      // Prefer the fallback error (latest), but keep primary code in message for ops.
      throw new LlmGatewayError(
        fallbackClassified.code,
        `${fallbackClassified.message} (primary failed with ${classified.code})`,
        {
          provider: fallbackClassified.provider ?? defaultCfg.provider,
          model: fallbackClassified.model ?? defaultCfg.model,
          httpStatus: fallbackClassified.httpStatus,
          retryable: fallbackClassified.retryable,
          fallbackEligible: false,
          circuitRelevant: fallbackClassified.circuitRelevant,
          retryAfterMs: fallbackClassified.retryAfterMs,
          cause: fallbackErr,
        }
      );
    }
  }
}

OPENAI_COMPATIBLE; // keep tree-shake hint
