/**
 * ExperienceRecall — Memory V2 P1（仅关键词）+ P2（hybrid embed + keyword）。
 *
 * 给 reason 节点（以及未来 Writer/Reflector 内部）一个统一入口：
 *   `recall(ctx) → 排好序的 Top-K 经验`
 *
 * 当前实现（P2，详见 docs/MEMORY_V2_DESIGN.md §6.7+§6.14）：
 *
 *   0. **混排路径选择**：构造时若提供 `embeddingClient + vectorStore` → 启用 hybrid；
 *      否则降级到 P1 的纯 keyword 模式（向后兼容；recall.test.ts 老用例不破坏）。
 *
 *   1. **池子收集**：
 *      - keyword 侧：原 P1 路径，`store.query(kinds × visibility) → POOL_LIMIT_PER_KIND`
 *      - vector 侧（hybrid 时）：query 走 EmbeddingClient → vectorStore.search 两次：
 *          a) project_shared kinds（无 visibility 过滤）
 *          b) reflective × ctx.definitionId（agent_private 严格隔离）
 *        拿到 experienceId list → store.findManyByIds 还原 Experience
 *
 *   2. **统一打分**：每条 experience 都跑 scoreOne，合分公式：
 *        - keyword-only：  0.5*keyword + 0.3*quality + 0.2*recency
 *        - hybrid:         0.40*embed + 0.25*keyword + 0.20*quality + 0.15*recency
 *      （embed 权重最大；但 keyword 保留，应对 query 含强 entity（ticker/factor 名）时
 *       embed 反而 dilute 的情况）
 *
 *   3. **link 1 跳扩展**：取 top-3 seed 沿 `evidence_of / derive_from` 拿邻居补回池
 *      （hybrid 模式下也走，邻居用相同公式但 embed 取 vector store 命中的分；
 *       若邻居没向量则 embed=0，退化到 keyword）
 *
 *   4. **截断 + emit**：返回 Top-K；每条 emit `experience_recalled` 给 Bus。
 *
 * 设计原则：
 *   - **无副作用的 recall**：返回的对象本身不被 mutate；emit 是 fire-and-forget
 *   - **Store 抽象**：只调 store.query / findManyByIds / linkExpand；vectorStore 同样抽象
 *   - **降级路径明确**：embeddingClient.embed 抛错 → 整次 hybrid 退到 keyword-only
 *     （记 warn 不抛），保证 reason 节点永远拿到结果
 *   - **可注入 now / random**：未来想加随机重排或时间窗都不动接口
 */

import type { Experience, ExperienceKind, ExperienceLinkRelation } from "../../../types/entities";
import type { EmbeddingClient } from "../../llm/embedding-client";
import type { ExperienceBus } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";
import type { ExperienceVectorStore, VectorSearchHit } from "../experience-vector-store";

// ───────────────────────── ctx & 结果 ─────────────────────────

export interface RecallContext {
  projectId: string;
  definitionId: string | null;
  /** agent 的 role，未来支持 role_shared 时会用 */
  role?: string;
  /** 自然语言 query（来自 reason 节点的 goal+ticker+context） */
  query: string;
  /** 默认 [semantic, procedural, reflective] */
  kinds?: ExperienceKind[];
  topK?: number;
  /** Recall 命中后 emit experience_recalled 时附的 workflowRunId / agentStepId */
  workflowRunId?: string;
  agentStepId?: string | null;
  /** 单测可关掉，避免污染外部 Bus */
  silentEmit?: boolean;
}

export interface RecallResult {
  experience: Experience;
  /** 0..1 合分；越大越靠前 */
  score: number;
  /** 命中分量明细（hybrid 模式下含 embed；keyword-only 下 embed=0） */
  components: {
    keyword: number;
    quality: number;
    recency: number;
    embed: number;
  };
  /** 0..N-1 在最终结果中的 rank */
  rank: number;
  /** 是否通过 link 扩展进来 */
  viaLink: boolean;
  /** 是否通过 embedding 召回进来（hybrid 模式下） */
  viaEmbed: boolean;
}

const DEFAULT_KINDS: ExperienceKind[] = ["semantic", "procedural", "reflective"];
const DEFAULT_TOPK = 5;
const POOL_LIMIT_PER_KIND = 60;
const LINK_SEED_COUNT = 3;
const RECENCY_HALF_LIFE_DAYS = 30;
const LINK_RELATIONS_EXPAND: ExperienceLinkRelation[] = ["derive_from", "evidence_of"];

/** Hybrid 召回时拉宽倍数（最终结果 topK，向量召回拉 topK*VECTOR_OVERSAMPLE） */
const VECTOR_OVERSAMPLE = 3;

/** 合分权重（hybrid） — embed 主导但保留 keyword 兜底强 entity */
const W_EMBED = 0.4;
const W_KEYWORD_HYBRID = 0.25;
const W_QUALITY_HYBRID = 0.2;
const W_RECENCY_HYBRID = 0.15;

/** 合分权重（keyword-only，保留 P1 公式） */
const W_KEYWORD_ONLY = 0.5;
const W_QUALITY_ONLY = 0.3;
const W_RECENCY_ONLY = 0.2;

// ───────────────────────── 主入口 ─────────────────────────

export interface RecallEngineOptions {
  store: ExperienceStore;
  bus?: ExperienceBus;
  now?: () => Date;
  /** Memory V2 P2：可选向量召回（两者都给才启用 hybrid，否则降级 keyword-only） */
  embeddingClient?: EmbeddingClient;
  vectorStore?: ExperienceVectorStore;
}

export class ExperienceRecall {
  private readonly store: ExperienceStore;
  private readonly bus: ExperienceBus | undefined;
  private readonly now: () => Date;
  private readonly embeddingClient: EmbeddingClient | undefined;
  private readonly vectorStore: ExperienceVectorStore | undefined;

  constructor(opts: RecallEngineOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
    // 只有两者都给才启用 hybrid；任一缺失自动降级 keyword-only
    if (opts.embeddingClient && opts.vectorStore) {
      this.embeddingClient = opts.embeddingClient;
      this.vectorStore = opts.vectorStore;
    }
  }

  /** 是否启用 hybrid 模式（embedding + keyword 混排） */
  get hybridEnabled(): boolean {
    return !!(this.embeddingClient && this.vectorStore);
  }

  async recall(ctx: RecallContext): Promise<RecallResult[]> {
    const topK = ctx.topK ?? DEFAULT_TOPK;
    const kinds = ctx.kinds ?? DEFAULT_KINDS;

    // 1) 池子（keyword 路径）
    const pool = await this.collectPool(ctx, kinds);

    // 2) 向量召回（hybrid 路径，且 query 非空）
    const vectorHitsMap = await this.collectVectorHits(ctx, kinds);
    const useHybrid = vectorHitsMap.size > 0;

    // 若两路池子都空 → 早返
    if (pool.length === 0 && vectorHitsMap.size === 0) return [];

    // 把向量命中的 experience 也拉进来（去重）
    const vectorIds = Array.from(vectorHitsMap.keys());
    const fromVector = vectorIds.length > 0 ? await this.store.findManyByIds(vectorIds) : [];
    // 过滤 archived 的向量命中（防 vector 表与 sqlite 状态错位）
    const fromVectorAlive = fromVector.filter((e) => e.validTo === null);

    const dedupePool = mergeExperiences(pool, fromVectorAlive);

    // 3) 评分
    const tokens = tokenize(ctx.query);
    const allScored = dedupePool.map((exp) =>
      this.scoreOne(exp, tokens, vectorHitsMap.get(exp.id) ?? null, false)
    );

    /**
     * 池阶段必须有"实际命中"（关键词命中 或 向量命中）才参与排序。
     * 若 query 为空（tokens 空 且 无 vector）则保留所有项。
     */
    const seedsScored =
      tokens.length === 0 && !useHybrid
        ? allScored
        : allScored.filter((r) => r.components.keyword > 0 || r.components.embed > 0);

    // 4) link 1 跳扩展（仅当池有有效命中时执行）
    const linkScored = await this.expandWithLinks(seedsScored, tokens, vectorHitsMap);

    // 5) 合并 + dedupe + 排序
    const merged = mergeUnique([...seedsScored, ...linkScored]);
    merged.sort((a, b) => b.score - a.score);
    const top = merged.slice(0, topK);
    top.forEach((r, i) => {
      r.rank = i;
    });

    // 6) emit (fire-and-forget)
    if (!ctx.silentEmit && this.bus && ctx.workflowRunId) {
      const wfId = ctx.workflowRunId;
      const stepId = ctx.agentStepId ?? null;
      for (const r of top) {
        this.bus.emit({
          type: "experience_recalled",
          experienceId: r.experience.id,
          workflowRunId: wfId,
          agentStepId: stepId,
          rank: r.rank,
          score: r.score,
        });
      }
    }

    return top;
  }

  // ─── 内部 ───

  /**
   * 跑向量召回，返回 experienceId → cosine score 映射。
   * 任一异常（embed 失败 / vectorStore 失败）都 catch + warn，降级到空 Map（keyword-only）。
   */
  private async collectVectorHits(
    ctx: RecallContext,
    kinds: ExperienceKind[]
  ): Promise<Map<string, VectorSearchHit>> {
    const out = new Map<string, VectorSearchHit>();
    if (!this.embeddingClient || !this.vectorStore) return out;
    if (!ctx.query || ctx.query.trim().length === 0) return out;
    const topK = ctx.topK ?? DEFAULT_TOPK;
    const lance = topK * VECTOR_OVERSAMPLE;

    try {
      const { vectors } = await this.embeddingClient.embed([ctx.query]);
      const queryVec = vectors[0];
      if (!queryVec) return out;

      const client = this.embeddingClient;
      const vstore = this.vectorStore;

      const sharedKinds = kinds.filter(
        (k) => k === "semantic" || k === "procedural" || k === "identity"
      );
      if (sharedKinds.length > 0) {
        const hits = await vstore.search(
          queryVec,
          {
            scope: "project",
            scopeId: ctx.projectId,
            model: client.model,
            dimension: client.dimension,
            kinds: sharedKinds,
            visibilities: ["project_shared"],
          },
          lance
        );
        for (const h of hits) out.set(h.experienceId, h);
      }

      if (kinds.includes("reflective") && ctx.definitionId) {
        const hits = await vstore.search(
          queryVec,
          {
            scope: "project",
            scopeId: ctx.projectId,
            model: client.model,
            dimension: client.dimension,
            kinds: ["reflective"],
            visibilities: ["agent_private"],
            definitionId: ctx.definitionId,
          },
          lance
        );
        for (const h of hits) {
          // 若同 id 已被 shared 命中（理论不应该，但保护），取分高的
          const existing = out.get(h.experienceId);
          if (!existing || h.score > existing.score) out.set(h.experienceId, h);
        }
      }
    } catch (err) {
      console.warn(
        `[recall] hybrid vector path failed, falling back to keyword-only: ${(err as Error).message}`
      );
      out.clear();
    }
    return out;
  }

  private async collectPool(ctx: RecallContext, kinds: ExperienceKind[]): Promise<Experience[]> {
    const out: Experience[] = [];

    // semantic / procedural / identity → project_shared
    const sharedKinds = kinds.filter(
      (k) => k === "semantic" || k === "procedural" || k === "identity"
    );
    if (sharedKinds.length > 0) {
      const shared = await this.store.query({
        kind: sharedKinds,
        scope: "project",
        scopeId: ctx.projectId,
        archivalMode: "exclude_archived",
        orderBy: "quality_desc",
        limit: POOL_LIMIT_PER_KIND,
      });
      out.push(...shared);
    }

    // reflective → 仅 ctx.definitionId 自己
    if (kinds.includes("reflective") && ctx.definitionId) {
      const own = await this.store.query({
        kind: "reflective",
        scope: "project",
        scopeId: ctx.projectId,
        definitionId: ctx.definitionId,
        archivalMode: "exclude_archived",
        orderBy: "quality_desc",
        limit: POOL_LIMIT_PER_KIND,
      });
      out.push(...own);
    }

    // episodic 通常不召回（噪声大）；P2 起按 sub_kind=workflow_trail 选择性扩展
    return out;
  }

  private scoreOne(
    exp: Experience,
    tokens: string[],
    vectorHit: VectorSearchHit | null,
    viaLink: boolean
  ): RecallResult {
    const haystack = buildHaystack(exp);
    const keyword = keywordScore(haystack, tokens);
    const quality = exp.qualityScore;
    const recency = recencyScore(exp.validFrom, this.now());
    // cosine ∈ [-1, 1]；clamp 到 [0, 1] 当向量分用
    const embed = vectorHit ? Math.max(0, Math.min(1, vectorHit.score)) : 0;
    const viaEmbed = vectorHit !== null;

    // 选公式：hybrid 引擎开启 → 4 项；否则保留 P1 老 3 项公式
    let total: number;
    if (this.hybridEnabled) {
      total =
        W_EMBED * embed +
        W_KEYWORD_HYBRID * keyword +
        W_QUALITY_HYBRID * quality +
        W_RECENCY_HYBRID * recency;
    } else {
      total = W_KEYWORD_ONLY * keyword + W_QUALITY_ONLY * quality + W_RECENCY_ONLY * recency;
    }
    return {
      experience: exp,
      score: total,
      components: { keyword, quality, recency, embed },
      rank: -1,
      viaLink,
      viaEmbed,
    };
  }

  private async expandWithLinks(
    scored: RecallResult[],
    tokens: string[],
    vectorHitsMap: Map<string, VectorSearchHit>
  ): Promise<RecallResult[]> {
    const seeds = scored
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, LINK_SEED_COUNT)
      .map((r) => r.experience.id);
    if (seeds.length === 0) return [];
    const neighbors = await this.store.linkExpand({
      seedIds: seeds,
      relations: LINK_RELATIONS_EXPAND,
      maxDepth: 1,
    });
    if (neighbors.length === 0) return [];
    // 邻居若也有 vector 命中（同 model+dim 已被向量索引）则带上分；否则 embed=0
    return neighbors
      .filter((n) => n.validTo === null)
      .map((n) => this.scoreOne(n, tokens, vectorHitsMap.get(n.id) ?? null, true));
  }
}

// ───────────────────────── 纯函数辅助 ─────────────────────────

export function tokenize(query: string): string[] {
  if (!query) return [];
  return Array.from(
    new Set(
      query
        .toLowerCase()
        // 中英混合：英文按空白/标点拆，中文按字符拆（最小召回粒度）
        .replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `)
        .split(/[\s,.;:!?()\[\]{}"'，。；：！？（）「」『』]+/u)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  );
}

export function keywordScore(haystack: string, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const lower = haystack.toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (lower.includes(t)) hits += 1;
  }
  return hits / tokens.length;
}

export function recencyScore(validFromIso: string, now: Date): number {
  const t = new Date(validFromIso).getTime();
  if (Number.isNaN(t)) return 0;
  const days = Math.max(0, (now.getTime() - t) / 86_400_000);
  return Math.exp(-days / RECENCY_HALF_LIFE_DAYS);
}

function buildHaystack(exp: Experience): string {
  const summary = exp.contentJson.summary ?? "";
  const body = (exp.contentJson.body ?? "").toString();
  const tags = exp.tagsJson.join(" ");
  const sub = exp.subKind ?? "";
  return [summary, body, tags, sub].join(" ");
}

function mergeUnique(items: RecallResult[]): RecallResult[] {
  const seen = new Map<string, RecallResult>();
  for (const r of items) {
    const cur = seen.get(r.experience.id);
    if (!cur || r.score > cur.score) seen.set(r.experience.id, r);
  }
  return Array.from(seen.values());
}

function mergeExperiences(a: Experience[], b: Experience[]): Experience[] {
  const seen = new Map<string, Experience>();
  for (const e of a) seen.set(e.id, e);
  for (const e of b) if (!seen.has(e.id)) seen.set(e.id, e);
  return Array.from(seen.values());
}

// ───────────────────────── 渲染 Prompt 用 ─────────────────────────

/**
 * 把 Top-K 经验渲染成可塞 system prompt 的 Markdown 段落。
 * reason 节点拼到 `## Memory · Recall (live)` 下。
 */
export function renderRecallBlockForPrompt(results: RecallResult[]): string {
  if (results.length === 0) return "";
  const lines: string[] = ["## Memory · Recall (live)"];
  lines.push(
    "> 以下经验由 ExperienceRecall 按当前任务上下文召回，按相关性 + 质量排序。优先复用，必要时调 `write_memory` 留下新结论。"
  );
  lines.push("");
  for (const r of results) {
    const exp = r.experience;
    const kindBadge = `[${exp.kind}${exp.subKind ? `/${exp.subKind}` : ""}]`;
    const metric = `score=${r.score.toFixed(3)} q=${exp.qualityScore.toFixed(2)} use=${exp.useCount}`;
    lines.push(`### ${kindBadge} ${truncate(exp.contentJson.summary, 90)}`);
    lines.push(`> ${metric}${r.viaLink ? " · via link" : ""}`);
    const body = (exp.contentJson.body ?? "").toString();
    if (body) {
      lines.push("");
      lines.push(truncate(body, 800));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
