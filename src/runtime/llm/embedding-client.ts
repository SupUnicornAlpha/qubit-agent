/**
 * EmbeddingClient — Memory V2 P2 嵌入向量统一抽象。
 *
 * 设计原则：
 *   - **接口先行**：所有 caller（Embedder pipe / Recall）只依赖 `EmbeddingClient` 接口；
 *     OpenAI / Mock / 未来的本地 sentence-transformers 都是可替换实现。
 *   - **批量优先**：上层永远按 batch 调用（OpenAI text-embedding-3 每请求 ≤2048 条），
 *     单条调用只是 batch 的退化。
 *   - **失败兜底**：网络失败 / API quota 时 caller 应能拿到明确错误而非静默返回零向量；
 *     `failOpen` 模式由 caller 决定（Embedder pipe 标记 failed 留到下次；Recall 降级到
 *     keyword-only）。
 *   - **可观测**：每次调用上报 tokens / latency / batchSize，便于成本追踪。
 *
 * 当前实现：
 *   - `OpenAIEmbeddingClient`：走 OPENAI_API_KEY，默认模型 text-embedding-3-small (1536 维)。
 *     生产环境使用；env 没有 key 时构造直接抛错（避免运行时静默切到 mock）。
 *   - `MockEmbeddingClient`：哈希 → 固定维度向量（默认 1536）；单测专用。完全
 *     deterministic（同输入 → 同向量），便于断言。
 *
 * **不实现**的：
 *   - 缓存层 — 上层调用者（Embedder pipe）天然 dedupe；不在这里加 cache 防止
 *     缓存击穿调试困难。未来如需 cache 可在 Decorator 层加。
 *   - 自动 chunking — 同样由 caller 控制。embeddings 一般是 1-2 句话短文本，
 *     无需 chunk。
 */

import OpenAI from "openai";

// ───────────────────────── 接口 ─────────────────────────

export interface EmbeddingClient {
  /** 嵌入模型名（log / 监控用） */
  readonly model: string;
  /** 向量维度（建表时要） */
  readonly dimension: number;
  /**
   * 批量嵌入。返回顺序与 texts 顺序严格对应。
   * 任一文本失败应抛错（caller 决定是否兜底）；不会返回 null/undefined 元素。
   */
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export interface EmbeddingResult {
  vectors: number[][];
  /** 本次调用真实消耗（无可用计数时为 0） */
  tokensUsed: number;
  /** 端到端 latency ms */
  latencyMs: number;
}

// ───────────────────────── OpenAI 实现 ─────────────────────────

export interface OpenAIEmbeddingOptions {
  /** 默认 text-embedding-3-small（1536 维），便宜且足够覆盖 ≤8k 文本 */
  model?: string;
  /** 一般跟 OPENAI_API_KEY 走；显式传入用于多 key/多账号 */
  apiKey?: string;
  baseURL?: string;
  /** OpenAI 单 batch 上限 2048；保守用 256 */
  maxBatchSize?: number;
}

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_DIMENSION = 1536;
const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

export class OpenAIEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dimension: number;
  private readonly client: OpenAI;
  private readonly maxBatchSize: number;

  constructor(opts: OpenAIEmbeddingOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL;
    this.dimension = MODEL_DIMENSIONS[this.model] ?? DEFAULT_DIMENSION;
    this.maxBatchSize = Math.max(1, Math.min(2048, opts.maxBatchSize ?? 256));
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAIEmbeddingClient: OPENAI_API_KEY missing. Set env or pass apiKey explicitly."
      );
    }
    this.client = new OpenAI({
      apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0) {
      return { vectors: [], tokensUsed: 0, latencyMs: 0 };
    }
    const startedAt = Date.now();
    const vectors: number[][] = new Array(texts.length);
    let tokensUsed = 0;

    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      // OpenAI: 空字符串会被拒，先 sanitize
      const sanitized = batch.map((t) => (t.trim().length === 0 ? " " : t));
      const res = await this.client.embeddings.create({
        model: this.model,
        input: sanitized,
      });
      // res.data 顺序与 input 顺序一致（OpenAI 文档保证）
      for (let k = 0; k < res.data.length; k += 1) {
        const item = res.data[k];
        if (!item) {
          throw new Error(`OpenAI embeddings returned undefined item at ${i + k}`);
        }
        vectors[i + k] = item.embedding;
      }
      const usage = (res as { usage?: { total_tokens?: number } }).usage;
      if (usage?.total_tokens) tokensUsed += usage.total_tokens;
    }

    return { vectors, tokensUsed, latencyMs: Date.now() - startedAt };
  }
}

// ───────────────────────── Mock 实现（测试用）─────────────────────────

export interface MockEmbeddingOptions {
  /** 默认 16；测试快 + 容易断言；可改 1536 测对齐生产维度 */
  dimension?: number;
  model?: string;
  /** 注入延迟 ms，模拟慢 API（默认 0） */
  latencyMs?: number;
}

/**
 * 哈希式嵌入：deterministic、无外部依赖。
 *
 * 嵌入向量构造（简单 hash → cos sim 大致可区分）：
 *   - tokenize（lowercase + 中文按字 + 英文按 word）
 *   - 每个 token 用 djb2 hash 投到 dimension 个桶
 *   - 累加后 L2 normalize
 * 性质：
 *   - 相同输入 → 相同向量；
 *   - 高度重合的文本 → 高 cosine（适合 Recall 单测断言）；
 *   - 完全不同 → 大概率正交（但因为是 hash，不保证）。
 */
export class MockEmbeddingClient implements EmbeddingClient {
  readonly model: string;
  readonly dimension: number;
  private readonly latencyMs: number;
  /** 测试可读 call log */
  public calls: { texts: string[]; ts: number }[] = [];

  constructor(opts: MockEmbeddingOptions = {}) {
    this.model = opts.model ?? "mock-embed-1";
    this.dimension = opts.dimension ?? 16;
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    const startedAt = Date.now();
    this.calls.push({ texts: [...texts], ts: startedAt });
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    const vectors = texts.map((t) => hashEmbed(t, this.dimension));
    return {
      vectors,
      tokensUsed: texts.reduce((acc, t) => acc + Math.ceil(t.length / 4), 0),
      latencyMs: Date.now() - startedAt,
    };
  }
}

// ───────────────────────── 工具函数 ─────────────────────────

/**
 * 公开：把任意字符串投到指定维度的 hash embedding。
 * 用途：MockEmbeddingClient 内部 + Recall 单测构造"语义相似"向量。
 */
export function hashEmbed(text: string, dimension: number): number[] {
  const vec = new Array<number>(dimension).fill(0);
  const tokens = tokenizeForEmbedding(text);
  for (const tok of tokens) {
    const h = djb2(tok);
    // 主桶 +1，相邻 ±1 桶 +0.5（让相邻文本有更多共现，便于测试相似度）
    vec[h % dimension] += 1;
    vec[(h + 1) % dimension] += 0.5;
    vec[(h + dimension - 1) % dimension] += 0.5;
  }
  return l2Normalize(vec);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dim mismatch ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function tokenizeForEmbedding(text: string): string[] {
  const lower = text.toLowerCase();
  // 中文按字切；其他按 word
  const out: string[] = [];
  let buf = "";
  for (const ch of lower) {
    if (/[\u4e00-\u9fa5]/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      out.push(ch);
    } else if (/[a-z0-9_]/.test(ch)) {
      buf += ch;
    } else {
      if (buf) {
        out.push(buf);
        buf = "";
      }
    }
  }
  if (buf) out.push(buf);
  return out;
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h = h >>> 0;
  }
  return h;
}

function l2Normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  return v.map((x) => x / norm);
}

// ───────────────────────── 默认 client 工厂 ─────────────────────────

let _client: EmbeddingClient | null = null;

/**
 * 取进程内默认 client：
 *   - 优先用 setEmbeddingClientForTesting 注入的 mock；
 *   - 否则若 OPENAI_API_KEY 存在 → OpenAIEmbeddingClient；
 *   - 否则返回 null（caller 应降级，比如 Recall 走 keyword-only）。
 */
export function getDefaultEmbeddingClient(): EmbeddingClient | null {
  if (_client) return _client;
  if (process.env.OPENAI_API_KEY) {
    _client = new OpenAIEmbeddingClient();
    return _client;
  }
  return null;
}

export function setEmbeddingClientForTesting(c: EmbeddingClient | null): void {
  _client = c;
}
