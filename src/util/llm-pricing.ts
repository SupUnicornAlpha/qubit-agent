/**
 * LLM 调用 Cost 估算（USD）。
 *
 * 设计目的（详见 docs/MONITORING_V2_DESIGN.md §4.1.1 / §7.5）：
 *   - 监控 V2 需要在 `llm_call_log.cost_usd` 写入每次调用的估算成本，
 *     用于 `/llm/usage` 端点聚合 24h cost。
 *   - 国内本地推理（ollama / mock）没有 cost 概念，返回 0；
 *     外部 provider 按 prompt+completion token 的单价表估算。
 *
 * 单价（USD per 1M tokens，2026Q1 公开价表，使用就近 round-to-cent）：
 *   - openai / gpt-4o            : prompt $2.50  / completion $10.00
 *   - openai / gpt-4o-mini       : prompt $0.15  / completion $0.60
 *   - openai / o1-mini           : prompt $3.00  / completion $12.00
 *   - openai / o1                : prompt $15.00 / completion $60.00
 *   - anthropic / claude-3.5-sonnet : prompt $3.00  / completion $15.00
 *   - anthropic / claude-3-haiku    : prompt $0.25  / completion $1.25
 *   - deepseek / deepseek-chat   : prompt $0.27  / completion $1.10
 *   - qwen / qwen-plus           : prompt $0.40  / completion $1.20
 *   - zhipu / glm-4              : prompt $0.50  / completion $1.50
 *   - ollama / *                 : 本地推理，零成本
 *   - mock / *                   : 测试 stub，零成本
 *
 * 来源 / 维护：
 *   单价是 2026Q1 公开页面整理，**会过期**。为避免每个 PR 都改硬编码：
 *   - DB 中 `llm_provider_config` 后续 P2 可加 `priceUsdPer1MTokens` 列覆盖默认；
 *   - 调用端拿不到自定义价时落到本表的 fallback；
 *   - 单价跑偏不会影响业务正确性，仅 cost 估算偏差。
 *
 * 实现是纯函数：传 `{ provider, model, promptTokens, completionTokens }` 返回 USD。
 */

export type LlmPricingInput = {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
};

type PriceRow = {
  /** USD / 1M prompt tokens */
  inUsdPerM: number;
  /** USD / 1M completion tokens */
  outUsdPerM: number;
};

/**
 * 静态价表：`provider:model` 作为 key（lower case）。
 * 命中时直接用；不命中按 provider 默认（fallback）；都不命中返回 0。
 *
 * 价目变动直接改这张表的具体单价；不要在调用方再硬编码。
 */
const PRICE_TABLE: ReadonlyMap<string, PriceRow> = new Map<string, PriceRow>([
  ["openai:gpt-4o", { inUsdPerM: 2.5, outUsdPerM: 10 }],
  ["openai:gpt-4o-mini", { inUsdPerM: 0.15, outUsdPerM: 0.6 }],
  ["openai:gpt-4-turbo", { inUsdPerM: 10, outUsdPerM: 30 }],
  ["openai:o1", { inUsdPerM: 15, outUsdPerM: 60 }],
  ["openai:o1-mini", { inUsdPerM: 3, outUsdPerM: 12 }],
  ["anthropic:claude-3-5-sonnet-20241022", { inUsdPerM: 3, outUsdPerM: 15 }],
  ["anthropic:claude-3-5-sonnet-latest", { inUsdPerM: 3, outUsdPerM: 15 }],
  ["anthropic:claude-3-haiku-20240307", { inUsdPerM: 0.25, outUsdPerM: 1.25 }],
  ["anthropic:claude-3-opus-20240229", { inUsdPerM: 15, outUsdPerM: 75 }],
  ["deepseek:deepseek-chat", { inUsdPerM: 0.27, outUsdPerM: 1.1 }],
  ["deepseek:deepseek-reasoner", { inUsdPerM: 0.55, outUsdPerM: 2.19 }],
  ["qwen:qwen-plus", { inUsdPerM: 0.4, outUsdPerM: 1.2 }],
  ["qwen:qwen-max", { inUsdPerM: 1.4, outUsdPerM: 4.2 }],
  ["zhipu:glm-4", { inUsdPerM: 0.5, outUsdPerM: 1.5 }],
  ["zhipu:glm-4-air", { inUsdPerM: 0.07, outUsdPerM: 0.07 }],
]);

/**
 * provider 级 fallback：model 未命中时按 provider 默认价估（取该 provider 中位价）。
 * 此表纯为「估个数量级」用 — 真实 cost 仍以 provider 实际计费为准。
 */
const PROVIDER_FALLBACK: ReadonlyMap<string, PriceRow> = new Map<string, PriceRow>([
  ["openai", { inUsdPerM: 2.5, outUsdPerM: 10 }],
  ["anthropic", { inUsdPerM: 3, outUsdPerM: 15 }],
  ["deepseek", { inUsdPerM: 0.27, outUsdPerM: 1.1 }],
  ["qwen", { inUsdPerM: 0.4, outUsdPerM: 1.2 }],
  ["zhipu", { inUsdPerM: 0.5, outUsdPerM: 1.5 }],
]);

/**
 * 估算单次 LLM 调用成本（USD）。
 *   - 命中精确 `provider:model`：精准价
 *   - 不命中但 provider 已知：provider fallback
 *   - 都不命中（ollama / mock / 未知）：0
 *
 * 输出保留 6 位小数（约 1 个 token 量级），避免微调用因 round 丢失。
 */
export function estimateLlmCostUsd(input: LlmPricingInput): number {
  const key = `${input.provider}:${input.model}`.toLowerCase();
  const exact = PRICE_TABLE.get(key);
  const fallback = exact ?? PROVIDER_FALLBACK.get(input.provider.toLowerCase());
  if (!fallback) return 0;
  if (input.promptTokens <= 0 && input.completionTokens <= 0) return 0;
  const cost =
    (Math.max(0, input.promptTokens) * fallback.inUsdPerM) / 1_000_000 +
    (Math.max(0, input.completionTokens) * fallback.outUsdPerM) / 1_000_000;
  // 6 位小数：覆盖一次 1k token 调用的 ~$0.0001 精度
  return Number(cost.toFixed(6));
}

export const __TEST_ONLY__ = { PRICE_TABLE, PROVIDER_FALLBACK };
