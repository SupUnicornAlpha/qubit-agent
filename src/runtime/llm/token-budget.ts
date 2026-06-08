/**
 * Token Budget & History Compactor (P1-6, Round 6 复盘新增 2026-06-08)
 *
 * 背景：Round 6 实测 strategy / live_trading 的 p95 prompt token 已经 74K，逼近 128K
 * 默认 contextWindow 上限。当前 `reason.ts` 只有 `observations.slice(-3)` 一道简单截断，
 * 没有读 model 的真实 contextWindow，也没有处理单条 observation 体积爆炸（如
 * fetch_klines 返回 500 根 K 线一次几 K tokens）。
 *
 * 这个模块提供三件事：
 *   1. `estimateTokens(text)`：粗略估算（按 chars/4，与 OpenAI tiktoken 同数量级，足够做预算决策）
 *   2. `getContextWindow(provider, model)`：从 known-models 表查真实 contextWindow，未知模型 fallback 128K
 *   3. `compactObservations(observations, budget)`：按预算压缩 observation 列表：
 *      - 单条 > maxPerObservation chars → 截断到 maxPerObservation，并保留尾部 marker
 *      - 加总仍超 budget → 从前往后丢弃，保留最近 N 步 + 早期步骤的 stub 摘要
 *
 * 显式不做（留给 P2）：
 *   - 不调 LLM-as-summarizer 做"含义压缩"。LLM 摘要可以更精炼但要再发一次请求、增加成本；
 *     当前先用截断 + stub 试水，看是否能解决 74K → 60K 的问题
 *   - 不动 systemPrompt / skill recall block；那些由 prompt assembly 决定，
 *     compactor 只管 observation 数组
 */

/** 现代模型 contextWindow 真实值（截至 2026-06）。未列出的模型走默认 128K. */
export const KNOWN_MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  // OpenAI ─────────────────────────────────────────────────────────
  /** GPT-5 系列：M+ context window */
  "gpt-5.5": 400_000,
  "gpt-5.5-medium": 400_000,
  "gpt-5.3-codex": 400_000,
  "gpt-5": 400_000,
  /** GPT-4.5 / 4 系列：128K-256K 主流 */
  "gpt-4.5": 256_000,
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4": 128_000,
  o1: 200_000,
  "o1-mini": 128_000,
  o3: 200_000,
  "o3-mini": 128_000,
  // Anthropic ──────────────────────────────────────────────────────
  /** Claude 4.x 系列 */
  "claude-opus-4-8": 200_000,
  "claude-opus-4-8-thinking-high": 200_000,
  "claude-sonnet-4.6": 200_000,
  "claude-4.6-sonnet": 200_000,
  "claude-4.6-sonnet-medium-thinking": 200_000,
  "claude-sonnet-4-5": 200_000,
  "claude-haiku-4": 200_000,
  /** Claude 3.x */
  "claude-3-7-sonnet": 200_000,
  "claude-3-5-sonnet": 200_000,
  // Google ─────────────────────────────────────────────────────────
  "gemini-2.5-pro": 2_000_000,
  "gemini-2.5-flash": 1_000_000,
  // DeepSeek ───────────────────────────────────────────────────────
  "deepseek-chat": 128_000,
  "deepseek-r2": 128_000,
  "deepseek-reasoner": 128_000,
  // Qwen ───────────────────────────────────────────────────────────
  "qwen3-max": 256_000,
  "qwen3-plus": 256_000,
  "qwen2.5-max": 128_000,
  // Mock（测试用）
  "mock-reasoner": 32_000,
};

/** 默认值：未知模型 / 未配置 contextWindow 时的兜底（与 schema 默认一致） */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 估算文本的 token 数。
 *
 * 采用 `Math.ceil(text.length / 4)` 近似：
 *   - 英文：约 3.5-4.5 chars/token（OpenAI tiktoken 经验值）
 *   - 中文：约 1-1.5 chars/token，会被低估；但 prompt 里中文占比一般 < 50%，整体仍偏保守
 *   - JSON：约 3-5 chars/token，估算合理
 *
 * 我们故意取偏小的除数（4 → 偏大估计），让 budget 决策保守，避免实际超 window。
 * 真正 tokenizer 太重（需要拉 tiktoken 模型文件），且 P1-6 阶段不需要精度。
 */
export function estimateTokens(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * 估算一个 JSON-ifiable 对象序列化后的 token 数。
 * 避免 caller 自己拼 JSON.stringify 再算长度。
 */
export function estimateTokensOfJson(obj: unknown): number {
  try {
    return estimateTokens(JSON.stringify(obj));
  } catch {
    return 0;
  }
}

/**
 * 拿模型的 contextWindow（按"完整 model name"精确匹配 → 前缀匹配 → 默认）。
 *
 * @param model 模型名（如 "gpt-5.5-medium" / "claude-opus-4-8" / "deepseek-chat"）
 * @param explicitContextWindow 从 DB / model meta 显式拿到的值（优先级最高）
 */
export function getContextWindow(
  model: string | undefined | null,
  explicitContextWindow?: number | null
): number {
  if (
    typeof explicitContextWindow === "number" &&
    Number.isFinite(explicitContextWindow) &&
    explicitContextWindow > 0
  ) {
    return explicitContextWindow;
  }
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  const m = model.toLowerCase().trim();
  if (KNOWN_MODEL_CONTEXT_WINDOWS[m] !== undefined) return KNOWN_MODEL_CONTEXT_WINDOWS[m]!;
  /** 前缀匹配：gpt-4o-2024-* / claude-3-5-sonnet-2024-* 等带日期后缀 */
  const entries = Object.entries(KNOWN_MODEL_CONTEXT_WINDOWS);
  let best: { key: string; window: number } | null = null;
  for (const [key, win] of entries) {
    if (m.startsWith(key) && (!best || key.length > best.key.length)) {
      best = { key, window: win };
    }
  }
  if (best) return best.window;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * 给定 contextWindow + 期望的 maxOutputTokens，算出 prompt 端可用预算。
 *
 * 公式：
 *   promptBudget = max(0, floor(contextWindow * safetyRatio) - maxOutputTokens)
 *
 * - safetyRatio 默认 0.7：给 LLM 留 30% 给 reasoning trace / 工具调用 / 用量浮动
 * - 减去 maxOutputTokens：output 也算在 context 里，必须给它留位
 *
 * 例：
 *   128K window, 8K maxOutput → budget = 128_000 * 0.7 - 8000 = 81_600
 *   200K window, 8K maxOutput → budget = 200_000 * 0.7 - 8000 = 132_000
 *   1M  window, 8K maxOutput → budget = 1_000_000 * 0.7 - 8000 = 692_000
 */
export function computePromptBudget(input: {
  contextWindow: number;
  maxOutputTokens: number;
  safetyRatio?: number;
}): number {
  const ratio = input.safetyRatio ?? 0.7;
  const usable = Math.floor(input.contextWindow * ratio) - input.maxOutputTokens;
  return Math.max(0, usable);
}

// ────────────────────────────────────────────────────────────────────────
// History compactor
// ────────────────────────────────────────────────────────────────────────

export interface CompactObservationsOptions {
  /** 当前 prompt 已知占用（systemPrompt + sessionContext 等不动部分）的 token 估算 */
  fixedPromptTokens: number;
  /** prompt 端总预算（来自 computePromptBudget） */
  promptBudget: number;
  /** 保留多少条最近 observation 原文不动（默认 3） */
  keepRecent?: number;
  /** 单条 observation 序列化后的最大 char 数（默认 4000 chars ≈ 1K token） */
  maxCharsPerObservation?: number;
}

export interface CompactObservationsResult<T> {
  /**
   * 压缩后的 observations 数组（顺序保持时间序）。
   * 早期步骤被替换为 { summary: string, original_step_index: number }，
   * 最近 keepRecent 步保持原样（可能仍被单条截断）。
   */
  observations: Array<T | { __compacted: true; original_step_index: number; summary: string }>;
  /** 压缩后估算的 observation 总 token */
  estimatedTokens: number;
  /** 命中了哪些压缩动作（用于监控） */
  actions: {
    truncatedPerItem: number;
    droppedEarly: number;
    keptRecent: number;
  };
}

/**
 * 压缩 observations 数组到预算内。
 *
 * 算法：
 *   1. 倒序遍历：单条 > maxCharsPerObservation 的 → 截断到 maxCharsPerObservation + "[…truncated]"
 *   2. 从 -keepRecent 之前的老步骤开始，累计 token；超过 (budget - fixedPromptTokens) 的
 *      旧 observation 被替换为 { __compacted: true, summary: "step N: <tool_or_thought_first_120_chars>..." }
 *   3. 最近 keepRecent 步骤始终保留（最关键的上下文）
 *
 * 入参泛型 T：任意可序列化对象。compactor 不假设字段结构，只用 JSON.stringify 估算大小。
 */
export function compactObservations<T>(
  observations: T[],
  options: CompactObservationsOptions
): CompactObservationsResult<T> {
  const keepRecent = options.keepRecent ?? 3;
  const maxCharsPerObs = options.maxCharsPerObservation ?? 4000;
  const availableForObs = Math.max(0, options.promptBudget - options.fixedPromptTokens);

  /** 第 1 阶段：单条截断 */
  let truncatedPerItem = 0;
  type Entry =
    | { kind: "kept"; value: T; tokens: number }
    | { kind: "summary"; original_step_index: number; summary: string; tokens: number };

  const entries: Entry[] = observations.map((obs, idx) => {
    const json = (() => {
      try {
        return JSON.stringify(obs);
      } catch {
        return String(obs);
      }
    })();
    if (json.length > maxCharsPerObs) {
      truncatedPerItem += 1;
      const truncatedJson =
        json.slice(0, maxCharsPerObs) +
        `…[truncated ${json.length - maxCharsPerObs} chars]`;
      /**
       * 我们不真正修改 T 的内部结构（避免破坏 caller 期望的字段），而是替换成"已压缩" stub。
       * caller 想要更精细的 per-field 截断，应该在自己的 observation builder 里做。
       */
      return {
        kind: "summary",
        original_step_index: idx,
        summary: truncatedJson,
        tokens: estimateTokens(truncatedJson),
      };
    }
    return { kind: "kept", value: obs, tokens: estimateTokens(json) };
  });

  /** 第 2 阶段：从前往后丢弃，保留最近 keepRecent */
  const total = entries.length;
  const recentStart = Math.max(0, total - keepRecent);
  let runningTokens = 0;
  for (let i = recentStart; i < total; i++) runningTokens += entries[i]!.tokens;

  let droppedEarly = 0;
  /** 从最老的开始往后看，能塞就塞，塞不下就改成 stub */
  for (let i = 0; i < recentStart; i++) {
    const e = entries[i]!;
    if (runningTokens + e.tokens <= availableForObs) {
      runningTokens += e.tokens;
    } else {
      /** 替换成 stub：取序列化前 120 chars 当 summary，让 LLM 知道"这一步做了啥" */
      const stubJson =
        e.kind === "kept"
          ? (() => {
              try {
                return JSON.stringify(e.value).slice(0, 120);
              } catch {
                return String(e.value).slice(0, 120);
              }
            })()
          : e.summary.slice(0, 120);
      const stub = `step ${i + 1} compacted: ${stubJson}…`;
      entries[i] = {
        kind: "summary",
        original_step_index: i,
        summary: stub,
        tokens: estimateTokens(stub),
      };
      runningTokens += entries[i]!.tokens;
      droppedEarly += 1;
    }
  }

  const result: CompactObservationsResult<T>["observations"] = entries.map((e) =>
    e.kind === "kept"
      ? e.value
      : {
          __compacted: true as const,
          original_step_index: e.original_step_index,
          summary: e.summary,
        }
  );

  return {
    observations: result,
    estimatedTokens: runningTokens,
    actions: {
      truncatedPerItem,
      droppedEarly,
      keptRecent: Math.min(keepRecent, total),
    },
  };
}
