/**
 * ExperienceRecall — Memory V2 P1（详见 docs/MEMORY_V2_DESIGN.md §6.7）。
 *
 * 给 reason 节点（以及未来 Writer/Reflector 内部）一个统一入口：
 *   `recall(ctx) → 排好序的 Top-K 经验`
 *
 * 实现策略（用户决策 3：P1 仅关键词 + JSON path，P2 接 embedding）：
 *
 *   1. **池子收集**：按 kinds × visibility 路由从 Store 拉候选；
 *      - semantic / procedural / identity: project_shared 全捞
 *      - reflective: 仅 ctx.definitionId 自己（visibility=agent_private，决策 4）
 *
 *   2. **关键词打分** keywordScore(content, query) → 0..1；
 *      合分 = 0.5 * keyword + 0.3 * qualityScore + 0.2 * recency
 *
 *   3. **link 1 跳扩展**：取 top-3 seed 沿 `evidence_of / derive_from` 拿邻居补回池
 *
 *   4. **截断 + emit**：返回 Top-K；每条 emit `experience_recalled` 给 Bus，
 *      让 Writer 落 op_log(op=recall)。
 *
 * 设计原则：
 *   - **无副作用的 recall**：返回的对象本身不被 mutate；emit 是 fire-and-forget
 *   - **Store 抽象**：只调 store.query / store.findManyByIds / store.linkExpand，
 *     不直接 import drizzle —— 便于单测 InMemory 替换
 *   - **可注入 now / random**：未来想加随机重排或时间窗都不动接口
 */

import type { Experience, ExperienceKind, ExperienceLinkRelation } from "../../../types/entities";
import type { ExperienceBus } from "../experience-bus";
import type { ExperienceStore } from "../experience-store";

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
  /** 命中分量明细 */
  components: {
    keyword: number;
    quality: number;
    recency: number;
  };
  /** 0..N-1 在最终结果中的 rank */
  rank: number;
  /** 是否通过 link 扩展进来 */
  viaLink: boolean;
}

const DEFAULT_KINDS: ExperienceKind[] = ["semantic", "procedural", "reflective"];
const DEFAULT_TOPK = 5;
const POOL_LIMIT_PER_KIND = 60;
const LINK_SEED_COUNT = 3;
const RECENCY_HALF_LIFE_DAYS = 30;
const LINK_RELATIONS_EXPAND: ExperienceLinkRelation[] = ["derive_from", "evidence_of"];

// ───────────────────────── 主入口 ─────────────────────────

export interface RecallEngineOptions {
  store: ExperienceStore;
  bus?: ExperienceBus;
  now?: () => Date;
}

export class ExperienceRecall {
  private readonly store: ExperienceStore;
  private readonly bus: ExperienceBus | undefined;
  private readonly now: () => Date;

  constructor(opts: RecallEngineOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.now = opts.now ?? (() => new Date());
  }

  async recall(ctx: RecallContext): Promise<RecallResult[]> {
    const topK = ctx.topK ?? DEFAULT_TOPK;
    const kinds = ctx.kinds ?? DEFAULT_KINDS;

    // 1) 池子
    const pool = await this.collectPool(ctx, kinds);
    if (pool.length === 0) return [];

    // 2) 评分
    const tokens = tokenize(ctx.query);
    const allScored = pool.map((exp) => this.scoreOne(exp, tokens, false));
    /**
     * 池阶段必须有"实际关键词命中"才参与排序，避免低相关性高 quality 的旧经验
     * 占满 topK；让 link 扩展真正承担"语义辐射"职责。
     * 若 query 为空（tokens 空）则保留所有项（按 quality + recency 排序）。
     */
    const seedsScored =
      tokens.length === 0 ? allScored : allScored.filter((r) => r.components.keyword > 0);

    // 3) link 1 跳扩展（仅当池有有效命中时执行）
    const linkScored = await this.expandWithLinks(seedsScored, tokens);

    // 4) 合并 + dedupe + 排序
    const merged = mergeUnique([...seedsScored, ...linkScored]);
    merged.sort((a, b) => b.score - a.score);
    const top = merged.slice(0, topK);
    top.forEach((r, i) => {
      r.rank = i;
    });

    // 5) emit (fire-and-forget)
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

  private scoreOne(exp: Experience, tokens: string[], viaLink: boolean): RecallResult {
    const haystack = buildHaystack(exp);
    const keyword = keywordScore(haystack, tokens);
    const quality = exp.qualityScore;
    const recency = recencyScore(exp.validFrom, this.now());
    const total = 0.5 * keyword + 0.3 * quality + 0.2 * recency;
    return {
      experience: exp,
      score: total,
      components: { keyword, quality, recency },
      rank: -1,
      viaLink,
    };
  }

  private async expandWithLinks(scored: RecallResult[], tokens: string[]): Promise<RecallResult[]> {
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
    return neighbors.filter((n) => n.validTo === null).map((n) => this.scoreOne(n, tokens, true));
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
