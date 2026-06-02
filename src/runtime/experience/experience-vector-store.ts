/**
 * ExperienceVectorStore — Memory V2 P2 经验向量存储。
 *
 * 设计原则：
 *   - **接口先行**：caller（Embedder pipe / Recall）只依赖 `ExperienceVectorStore` 接口；
 *     SQLite/LanceDB 实现与 InMemory mock 等价交换。
 *   - **可过滤的向量召回**：召回时按 scope/scopeId/kind/visibility 等做 pre-filter，
 *     避免拉错 project 或越权拉到别人的 reflective。
 *   - **多模型并存**：vector 行带 model + dimension；换 embedding 模型时按这两列删旧。
 *     召回时必须传当前 model + dimension，跨模型不混搭（维度差异本身也不允许混）。
 *
 * 实现：
 *   - `LanceDbExperienceVectorStore`：生产实现；走 LanceDB EXPERIENCE_EMBEDDINGS 表
 *   - `InMemoryExperienceVectorStore`：测试实现；内部 array + cosine 暴力计算
 */

import { randomUUID } from "node:crypto";
import {
  type ExperienceEmbeddingVector,
  LANCE_TABLES,
  getLanceDb,
  vectorSearch,
} from "../../db/lancedb/client";
import { cosineSimilarity } from "../llm/embedding-client";

// ───────────────────────── Interface ─────────────────────────

export interface UpsertEmbeddingInput {
  experienceId: string;
  vector: number[];
  kind: string;
  subKind: string;
  scope: string;
  scopeId: string;
  definitionId?: string | null;
  visibility: string;
  model: string;
  dimension: number;
  sourceText: string;
}

export interface VectorSearchFilter {
  /** 必填：project / agent / global 之一；call site 都明确知道自己在召回哪个 scope */
  scope?: string;
  scopeId?: string;
  /** 必填：保证不跨模型；维度也要跟 vector 一致 */
  model: string;
  dimension: number;
  /** kind 白名单；空 = 全部 */
  kinds?: string[];
  /** visibility 白名单；reflective 跨 agent 不能召回到 */
  visibilities?: string[];
  /** 仅当 visibility 包含 agent_private 时用，过滤 definitionId */
  definitionId?: string | null;
}

export interface VectorSearchHit {
  experienceId: string;
  score: number; // cosine similarity (越高越像)
  model: string;
  kind: string;
  subKind: string;
}

export interface ExperienceVectorStore {
  /** 同一个 experienceId 多次 upsert 视为新版本（不删旧）；rebuild 时调 deleteByExperience 兜底 */
  upsert(input: UpsertEmbeddingInput): Promise<{ id: string }>;
  deleteByExperience(experienceId: string): Promise<number>;
  /** topK 同 model+dimension 的最近邻；caller 已经 normalize 过 query */
  search(
    queryVector: number[],
    filter: VectorSearchFilter,
    topK: number
  ): Promise<VectorSearchHit[]>;
}

// ───────────────────────── InMemory 实现 ─────────────────────────

export class InMemoryExperienceVectorStore implements ExperienceVectorStore {
  private rows: ExperienceEmbeddingVector[] = [];

  async upsert(input: UpsertEmbeddingInput): Promise<{ id: string }> {
    const id = randomUUID();
    this.rows.push({
      id,
      experienceId: input.experienceId,
      vector: input.vector,
      kind: input.kind,
      subKind: input.subKind,
      scope: input.scope,
      scopeId: input.scopeId,
      definitionId: input.definitionId ?? "",
      visibility: input.visibility,
      model: input.model,
      dimension: input.dimension,
      sourceText: input.sourceText,
      createdAt: new Date().toISOString(),
    });
    return { id };
  }

  async deleteByExperience(experienceId: string): Promise<number> {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.experienceId !== experienceId);
    return before - this.rows.length;
  }

  async search(
    queryVector: number[],
    filter: VectorSearchFilter,
    topK: number
  ): Promise<VectorSearchHit[]> {
    if (queryVector.length !== filter.dimension) {
      throw new Error(`vector dim ${queryVector.length} != filter.dimension ${filter.dimension}`);
    }
    const scored: VectorSearchHit[] = [];
    for (const r of this.rows) {
      if (r.model !== filter.model) continue;
      if (r.dimension !== filter.dimension) continue;
      if (filter.scope && r.scope !== filter.scope) continue;
      if (filter.scopeId && r.scopeId !== filter.scopeId) continue;
      if (filter.kinds && filter.kinds.length > 0 && !filter.kinds.includes(r.kind)) continue;
      if (
        filter.visibilities &&
        filter.visibilities.length > 0 &&
        !filter.visibilities.includes(r.visibility)
      )
        continue;
      // reflective 强制 agent 隔离
      if (r.visibility === "agent_private") {
        if (!filter.definitionId || r.definitionId !== filter.definitionId) continue;
      }
      const score = cosineSimilarity(queryVector, r.vector);
      scored.push({
        experienceId: r.experienceId,
        score,
        model: r.model,
        kind: r.kind,
        subKind: r.subKind,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    // 去重：同 experienceId 只留 top1（同一条 experience 多个版本的向量取最像那条）
    const seen = new Set<string>();
    const out: VectorSearchHit[] = [];
    for (const h of scored) {
      if (seen.has(h.experienceId)) continue;
      seen.add(h.experienceId);
      out.push(h);
      if (out.length >= topK) break;
    }
    return out;
  }

  /** 测试辅助 */
  size(): number {
    return this.rows.length;
  }
}

// ───────────────────────── LanceDB 实现 ─────────────────────────

export class LanceDbExperienceVectorStore implements ExperienceVectorStore {
  async upsert(input: UpsertEmbeddingInput): Promise<{ id: string }> {
    const row: ExperienceEmbeddingVector = {
      id: randomUUID(),
      experienceId: input.experienceId,
      vector: input.vector,
      kind: input.kind,
      subKind: input.subKind,
      scope: input.scope,
      scopeId: input.scopeId,
      definitionId: input.definitionId ?? "",
      visibility: input.visibility,
      model: input.model,
      dimension: input.dimension,
      sourceText: input.sourceText.slice(0, 2000),
      createdAt: new Date().toISOString(),
    };
    const db = await getLanceDb();
    const names = await db.tableNames();
    const tableName = LANCE_TABLES.EXPERIENCE_EMBEDDINGS;
    if (names.includes(tableName)) {
      const table = await db.openTable(tableName);
      await table.add([row]);
    } else {
      await db.createTable(tableName, [row]);
    }
    return { id: row.id };
  }

  async deleteByExperience(experienceId: string): Promise<number> {
    const db = await getLanceDb();
    const names = await db.tableNames();
    if (!names.includes(LANCE_TABLES.EXPERIENCE_EMBEDDINGS)) return 0;
    const table = await db.openTable(LANCE_TABLES.EXPERIENCE_EMBEDDINGS);
    const before = await table.countRows(`experienceId = '${escapeSql(experienceId)}'`);
    await table.delete(`experienceId = '${escapeSql(experienceId)}'`);
    return before;
  }

  async search(
    queryVector: number[],
    filter: VectorSearchFilter,
    topK: number
  ): Promise<VectorSearchHit[]> {
    if (queryVector.length !== filter.dimension) {
      throw new Error(`vector dim ${queryVector.length} != filter.dimension ${filter.dimension}`);
    }
    const where: string[] = [];
    where.push(`model = '${escapeSql(filter.model)}'`);
    where.push(`dimension = ${filter.dimension}`);
    if (filter.scope) where.push(`scope = '${escapeSql(filter.scope)}'`);
    if (filter.scopeId) where.push(`scopeId = '${escapeSql(filter.scopeId)}'`);
    if (filter.kinds && filter.kinds.length > 0) {
      const list = filter.kinds.map((k) => `'${escapeSql(k)}'`).join(",");
      where.push(`kind IN (${list})`);
    }
    if (filter.visibilities && filter.visibilities.length > 0) {
      const list = filter.visibilities.map((v) => `'${escapeSql(v)}'`).join(",");
      where.push(`visibility IN (${list})`);
    }
    // reflective 强制 agent 隔离：若 visibilities 包含 agent_private，必须给 definitionId
    if (filter.visibilities?.includes("agent_private") && filter.definitionId) {
      // 注：这里没法 OR 出来"visibility=agent_private AND definitionId=X 或 visibility != agent_private"
      // 简单实现：caller 分两次召回（agent_private 一次 + 其他一次），上层合并；这里只支持纯过滤
      // 当前 P2 阶段先 minimum；reason 节点也是分开两次召回的（一次 project shared，一次 agent private）
      where.push(`definitionId = '${escapeSql(filter.definitionId)}'`);
    }

    // 拉宽 topK 给后续 deduplication 留余量
    const lanceTop = topK * 3;
    const hits = await vectorSearch(
      LANCE_TABLES.EXPERIENCE_EMBEDDINGS,
      queryVector,
      lanceTop,
      where.join(" AND ")
    );

    // LanceDB 返回距离（_distance，欧氏）；我们的 vector 已 L2 normalize，
    // 因此 score = 1 - distance^2 / 2 ≈ cosine similarity。
    // 但 LanceDB v0.17 不保证 _distance 一致；为简化，重新计算 cosine。
    const scored: VectorSearchHit[] = [];
    for (const h of hits) {
      const vec = h.vector as number[];
      if (!Array.isArray(vec)) continue;
      scored.push({
        experienceId: String(h.experienceId),
        score: cosineSimilarity(queryVector, vec),
        model: String(h.model),
        kind: String(h.kind),
        subKind: String(h.subKind),
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const out: VectorSearchHit[] = [];
    for (const h of scored) {
      if (seen.has(h.experienceId)) continue;
      seen.add(h.experienceId);
      out.push(h);
      if (out.length >= topK) break;
    }
    return out;
  }
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

// ───────────────────────── 默认 store 工厂 ─────────────────────────

let _store: ExperienceVectorStore | null = null;

export function getExperienceVectorStore(): ExperienceVectorStore {
  if (_store) return _store;
  _store = new LanceDbExperienceVectorStore();
  return _store;
}

export function setExperienceVectorStoreForTesting(s: ExperienceVectorStore | null): void {
  _store = s;
}
