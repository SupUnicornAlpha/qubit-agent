/**
 * LLM 调用 Cost 估算（USD）。
 *
 * 设计目的（详见 docs/MONITORING_V2_DESIGN.md §4.1.1 / §7.5）：
 *   - 监控 V2 需要在 `llm_call_log.cost_usd` 写入每次调用的估算成本，
 *     用于 `/llm/usage` 端点聚合 24h cost。
 *   - 国内本地推理（ollama / mock）没有 cost 概念，返回 0；
 *     外部 provider 按 prompt+completion token 的单价表估算。
 *
 * P2 升级：
 *   - 引入 `cachedPromptTokens` 维度。命中 prompt cache 的 token 按上游公开折扣
 *     计费：OpenAI Responses cached input = uncached × 0.50；Anthropic prompt
 *     cache read = uncached × 0.10。表内每一行都可以单独标注 `cachedDiscount`，
 *     不写时落到 provider 级默认。
 *   - `reasoningTokens` 不单独计费 —— OpenAI / DeepSeek-R1 都把 reasoning 计入
 *     completionTokens，定价口径不变；本字段只为打点 / 监控所需，cost 函数原样
 *     按 completionTokens 计。这样语义清晰：caller 不必担心"重复扣钱"。
 *
 * 单价（USD per 1M tokens，2026Q1 公开价表）：
 *   - openai / gpt-5             : prompt $1.25  / completion $10.00 / cached 50%
 *   - openai / gpt-5-mini        : prompt $0.25  / completion $2.00  / cached 50%
 *   - openai / gpt-5-nano        : prompt $0.05  / completion $0.40  / cached 50%
 *   - openai / gpt-4o            : prompt $2.50  / completion $10.00 / cached 50%
 *   - openai / gpt-4o-mini       : prompt $0.15  / completion $0.60  / cached 50%
 *   - openai / o1                : prompt $15.00 / completion $60.00 / cached 50%
 *   - openai / o1-mini           : prompt $3.00  / completion $12.00 / cached 50%
 *   - openai / o3-mini           : prompt $1.10  / completion $4.40  / cached 50%
 *   - anthropic / claude-3.5-sonnet (v1+v2) : $3 / $15 / cached 10%
 *   - anthropic / claude-3-haiku    : $0.25 / $1.25 / cached 10%
 *   - deepseek / deepseek-chat      : $0.27 / $1.10
 *   - deepseek / deepseek-reasoner  : $0.55 / $2.19
 *   - qwen / qwen-plus              : $0.40 / $1.20
 *   - zhipu / glm-4                 : $0.50 / $1.50
 *   - ollama / *                    : 本地推理，零成本
 *   - mock / *                      : 测试 stub，零成本
 *
 * 实现仍是纯函数；签名向后兼容（cachedPromptTokens 可选，老 caller 不需要改）。
 */

export type LlmPricingInput = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * 命中 prompt cache 的 token 数（≤ promptTokens）。可选；不传等价于 0。
   * - OpenAI Responses 走 input_tokens_details.cached_tokens；
   * - Anthropic Messages 走 cache_read_input_tokens；
   * - 其它 provider 暂不暴露 → 不传。
   */
  cachedPromptTokens?: number;
  /**
   * Anthropic prompt-caching 专属：本次请求**写入**缓存的 token 数（≤ promptTokens）。
   * 计费为 `inUsdPerM × cacheWriteMultiplier`（Anthropic 公开 1.25×）。
   * 不传 / 0 = 没写 cache（或 provider 不支持），按普通 input 计费。
   */
  cacheCreationInputTokens?: number;
};

type PriceRow = {
  /** USD / 1M uncached prompt tokens */
  inUsdPerM: number;
  /** USD / 1M completion tokens（含 reasoning_tokens；上游不区分计费） */
  outUsdPerM: number;
  /**
   * cached input 的折扣系数（0–1）。`0.5` = uncached × 50%。
   * 不写时按 PROVIDER_CACHE_DISCOUNT 兜底。
   */
  cachedDiscount?: number;
};

/**
 * 静态价表：`provider:model` 作为 key（lower case）。
 * 命中时直接用；不命中按 provider 默认（fallback）；都不命中返回 0。
 *
 * 价目变动直接改这张表的具体单价；不要在调用方再硬编码。
 */
const PRICE_TABLE: ReadonlyMap<string, PriceRow> = new Map<string, PriceRow>([
  /** OpenAI GPT-5 family（2025 公开价；cached input 享 50% 折扣） */
  ["openai:gpt-5", { inUsdPerM: 1.25, outUsdPerM: 10, cachedDiscount: 0.5 }],
  ["openai:gpt-5-mini", { inUsdPerM: 0.25, outUsdPerM: 2, cachedDiscount: 0.5 }],
  ["openai:gpt-5-nano", { inUsdPerM: 0.05, outUsdPerM: 0.4, cachedDiscount: 0.5 }],
  /** OpenAI GPT-4 family */
  ["openai:gpt-4o", { inUsdPerM: 2.5, outUsdPerM: 10, cachedDiscount: 0.5 }],
  ["openai:gpt-4o-mini", { inUsdPerM: 0.15, outUsdPerM: 0.6, cachedDiscount: 0.5 }],
  ["openai:gpt-4-turbo", { inUsdPerM: 10, outUsdPerM: 30 }],
  ["openai:gpt-4.1", { inUsdPerM: 2, outUsdPerM: 8, cachedDiscount: 0.5 }],
  ["openai:gpt-4.1-mini", { inUsdPerM: 0.4, outUsdPerM: 1.6, cachedDiscount: 0.5 }],
  /** OpenAI o-series（推理模型；reasoning_tokens 已计入 completion，不单独定价） */
  ["openai:o1", { inUsdPerM: 15, outUsdPerM: 60, cachedDiscount: 0.5 }],
  ["openai:o1-mini", { inUsdPerM: 3, outUsdPerM: 12, cachedDiscount: 0.5 }],
  ["openai:o3-mini", { inUsdPerM: 1.1, outUsdPerM: 4.4, cachedDiscount: 0.5 }],
  /** Anthropic Claude 3.5 / 3.x（cache read 10%；cache write 125%，本表暂不算 write 加价） */
  ["anthropic:claude-3-5-sonnet-20241022", { inUsdPerM: 3, outUsdPerM: 15, cachedDiscount: 0.1 }],
  ["anthropic:claude-3-5-sonnet-latest", { inUsdPerM: 3, outUsdPerM: 15, cachedDiscount: 0.1 }],
  ["anthropic:claude-3-5-sonnet-v2", { inUsdPerM: 3, outUsdPerM: 15, cachedDiscount: 0.1 }],
  ["anthropic:claude-3-5-haiku-latest", { inUsdPerM: 0.8, outUsdPerM: 4, cachedDiscount: 0.1 }],
  ["anthropic:claude-3-haiku-20240307", { inUsdPerM: 0.25, outUsdPerM: 1.25, cachedDiscount: 0.1 }],
  ["anthropic:claude-3-opus-20240229", { inUsdPerM: 15, outUsdPerM: 75, cachedDiscount: 0.1 }],
  /** DeepSeek（暂不暴露 cache token；cachedDiscount 不设） */
  ["deepseek:deepseek-chat", { inUsdPerM: 0.27, outUsdPerM: 1.1 }],
  ["deepseek:deepseek-reasoner", { inUsdPerM: 0.55, outUsdPerM: 2.19 }],
  ["deepseek:deepseek-r1", { inUsdPerM: 0.55, outUsdPerM: 2.19 }],
  ["qwen:qwen-plus", { inUsdPerM: 0.4, outUsdPerM: 1.2 }],
  ["qwen:qwen-max", { inUsdPerM: 1.4, outUsdPerM: 4.2 }],
  ["zhipu:glm-4", { inUsdPerM: 0.5, outUsdPerM: 1.5 }],
  ["zhipu:glm-4-air", { inUsdPerM: 0.07, outUsdPerM: 0.07 }],
]);

/**
 * provider 级 fallback：model 未命中时按 provider 默认价估。
 * 仅为"估个数量级"用，真实 cost 以 provider 实际计费为准。
 */
const PROVIDER_FALLBACK: ReadonlyMap<string, PriceRow> = new Map<string, PriceRow>([
  ["openai", { inUsdPerM: 2.5, outUsdPerM: 10, cachedDiscount: 0.5 }],
  ["anthropic", { inUsdPerM: 3, outUsdPerM: 15, cachedDiscount: 0.1 }],
  ["deepseek", { inUsdPerM: 0.27, outUsdPerM: 1.1 }],
  ["qwen", { inUsdPerM: 0.4, outUsdPerM: 1.2 }],
  ["zhipu", { inUsdPerM: 0.5, outUsdPerM: 1.5 }],
]);

/**
 * provider 级 cached input 折扣兜底（PriceRow 没标 cachedDiscount 时启用）。
 * 老用户没传 cachedPromptTokens 时这个表完全用不到。
 */
const PROVIDER_CACHE_DISCOUNT: ReadonlyMap<string, number> = new Map([
  ["openai", 0.5],
  ["anthropic", 0.1],
]);

/**
 * provider 级 cache **write** 加价系数。Anthropic 写 cache 时按
 * `inUsdPerM × 1.25` 收费（这部分钱 5 分钟内被 cache_read 的 0.1× 折扣摊还回来）。
 * OpenAI Responses 不区分 cache write 与普通 input，统一按 input 价收。
 */
const PROVIDER_CACHE_WRITE_MULTIPLIER: ReadonlyMap<string, number> = new Map([
  ["anthropic", 1.25],
]);

/**
 * 估算单次 LLM 调用成本（USD）。
 *   - 命中精确 `provider:model`：精准价
 *   - 不命中但 provider 已知：provider fallback
 *   - 都不命中（ollama / mock / 未知）：0
 *
 * P3-1 cache write 计费拆分：
 *   cacheWritten = min(promptTokens, cacheCreationInputTokens)   // 写缓存的 token
 *   cacheRead    = min(promptTokens - cacheWritten, cachedPromptTokens)  // 命中缓存的 token
 *   uncached     = promptTokens - cacheWritten - cacheRead       // 既没写也没读
 *   inputCost = uncached × inUsdPerM
 *             + cacheRead × inUsdPerM × cachedDiscount       // Anthropic 0.1×, OpenAI 0.5×
 *             + cacheWritten × inUsdPerM × cacheWriteMultiplier  // Anthropic 1.25×, 其它 1.0×
 *
 * `cachedPromptTokens` / `cacheCreationInputTokens` 不传 / 0 时完全等价 P2 行为。
 *
 * 输出保留 6 位小数（约 1 个 token 量级），避免微调用因 round 丢失。
 */
export function estimateLlmCostUsd(input: LlmPricingInput): number {
  const provider = input.provider.toLowerCase();
  const key = `${provider}:${input.model}`.toLowerCase();
  const exact = PRICE_TABLE.get(key);
  const row = exact ?? PROVIDER_FALLBACK.get(provider);
  if (!row) return 0;
  const promptTokens = Math.max(0, input.promptTokens);
  const completionTokens = Math.max(0, input.completionTokens);
  if (promptTokens <= 0 && completionTokens <= 0) return 0;
  /**
   * 收紧 cache 维度：上游打点偶尔会出现 cached > prompt / 负数等病态值；
   * 不抛错，clamp 后继续算。
   */
  const rawWrite = input.cacheCreationInputTokens ?? 0;
  const cacheWritten = Math.max(0, Math.min(promptTokens, Math.floor(rawWrite)));
  const rawRead = input.cachedPromptTokens ?? 0;
  /** cache_read 与 cache_write 不能同时占用同一 token，read 在剩余预算里 clamp */
  const cacheRead = Math.max(
    0,
    Math.min(promptTokens - cacheWritten, Math.floor(rawRead)),
  );
  const uncached = promptTokens - cacheWritten - cacheRead;
  const readDiscount = row.cachedDiscount ?? PROVIDER_CACHE_DISCOUNT.get(provider) ?? 1;
  const writeMultiplier = PROVIDER_CACHE_WRITE_MULTIPLIER.get(provider) ?? 1;
  const cost =
    (uncached * row.inUsdPerM) / 1_000_000 +
    (cacheRead * row.inUsdPerM * readDiscount) / 1_000_000 +
    (cacheWritten * row.inUsdPerM * writeMultiplier) / 1_000_000 +
    (completionTokens * row.outUsdPerM) / 1_000_000;
  return Number(cost.toFixed(6));
}

export const __TEST_ONLY__ = {
  PRICE_TABLE,
  PROVIDER_FALLBACK,
  PROVIDER_CACHE_DISCOUNT,
  PROVIDER_CACHE_WRITE_MULTIPLIER,
};
