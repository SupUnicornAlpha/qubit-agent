/**
 * ExperienceStore — Memory V2 唯一持久化层（P0 落地，详见 docs/MEMORY_V2_DESIGN.md §4.1）。
 *
 * 设计原则：
 *   - **只做 CRUD**：不判 kind 路由、不判 visibility、不算 qualityScore；
 *     业务策略全部留给上层 5 个 pipe（Writer/Extractor/Reflector/Janitor/Recall）。
 *   - **唯一 DB 入口**：所有 Memory V2 业务模块必须只通过这一层访问 4 张新表；
 *     旧 sessionMemory / midtermMemory / longtermMemory 由旧路径继续维护，不在这里。
 *   - **可被 Mock 替换**：暴露 `ExperienceStore` 接口；P0 提供 SqliteExperienceStore +
 *     InMemoryExperienceStore 两种实现，前者跑生产，后者跑 5 个 pipe 的单测。
 *
 * 这一层的"高内聚"体现在：任何 pipe 写 experience，都用同样的 insert / update /
 * logOp 三个动作，不会出现"某个 pipe 用裸 drizzle 绕过 Store"的情况（除非要新增
 * 一个跨多表事务，那就在 Store 上加新方法）。
 */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  experienceLink as experienceLinkTable,
  experienceOpLog as experienceOpLogTable,
  experience as experienceTable,
} from "../../db/sqlite/schema";
import type {
  Experience,
  ExperienceContent,
  ExperienceLink,
  ExperienceOpLog,
} from "../../types/entities";
import type {
  ExperienceQuery,
  InsertExperienceInput,
  LinkExpandParams,
  OpLogInput,
  UpdateExperienceInput,
} from "./types";

// ───────────────────────── 接口契约 ─────────────────────────

export interface ExperienceStore {
  // 单体 CRUD
  insert(input: InsertExperienceInput): Promise<Experience>;
  update(id: string, patch: UpdateExperienceInput): Promise<Experience>;
  findById(id: string): Promise<Experience | null>;
  findManyByIds(ids: string[]): Promise<Experience[]>;

  // 简单查询（**不含** keyword/vector，那是 Recall 层）
  query(filter: ExperienceQuery): Promise<Experience[]>;

  // 关系图
  linkAdd(
    fromId: string,
    toId: string,
    relation: ExperienceLink["relation"],
    weight?: number
  ): Promise<ExperienceLink>;
  linkList(experienceId: string): Promise<ExperienceLink[]>;
  /**
   * 列出与 experienceId 有任意方向连接的全部 link（from=id OR to=id）。
   * Memory V2 P3 Inspector：邻居图需要看到 incoming + outgoing 两侧。
   */
  linkListByEither(experienceId: string): Promise<ExperienceLink[]>;
  /** 从 seedIds 出发按 relations 1..maxDepth 跳邻居，返回去重后的 experience */
  linkExpand(params: LinkExpandParams): Promise<Experience[]>;

  // 审计（写一条不做任何业务推断）
  logOp(input: OpLogInput): Promise<ExperienceOpLog>;
  listOps(experienceId: string, limit?: number): Promise<ExperienceOpLog[]>;
}

// ───────────────────────── 共用工具 ─────────────────────────

/** schema content_json 是 mode:json，但 select 回来可能是 string 也可能是已解析对象 */
function normalizeJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback;
  if (typeof raw === "string") {
    if (raw === "") return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function rowToExperience(row: typeof experienceTable.$inferSelect): Experience {
  return {
    id: row.id,
    kind: row.kind,
    subKind: row.subKind ?? "",
    scope: row.scope,
    scopeId: row.scopeId,
    definitionId: row.definitionId ?? null,
    visibility: row.visibility,
    contentJson: normalizeJson<ExperienceContent>(row.contentJson, { summary: "" }),
    tagsJson: normalizeJson<string[]>(row.tagsJson, []),
    qualityScore: row.qualityScore ?? 0.5,
    useCount: row.useCount ?? 0,
    successCount: row.successCount ?? 0,
    failCount: row.failCount ?? 0,
    decayAt: row.decayAt ?? null,
    validFrom: row.validFrom,
    validTo: row.validTo ?? null,
    parentId: row.parentId ?? null,
    sourceRunId: row.sourceRunId ?? null,
    embeddingRef: row.embeddingRef ?? null,
    pinned: Boolean(row.pinned),
    metadataJson: normalizeJson<Record<string, unknown>>(row.metadataJson, {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToLink(row: typeof experienceLinkTable.$inferSelect): ExperienceLink {
  return {
    id: row.id,
    fromId: row.fromId,
    toId: row.toId,
    relation: row.relation,
    weight: row.weight ?? 1,
    createdAt: row.createdAt,
  };
}

function rowToOpLog(row: typeof experienceOpLogTable.$inferSelect): ExperienceOpLog {
  return {
    id: row.id,
    experienceId: row.experienceId,
    op: row.op,
    workflowRunId: row.workflowRunId ?? null,
    outcome: row.outcome ?? null,
    actor: row.actor ?? "system",
    metadataJson: normalizeJson<Record<string, unknown>>(row.metadataJson, {}),
    createdAt: row.createdAt,
  };
}

// ───────────────────────── SQLite 实现 ─────────────────────────

export class SqliteExperienceStore implements ExperienceStore {
  async insert(input: InsertExperienceInput): Promise<Experience> {
    const db = await getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    await db.insert(experienceTable).values({
      id,
      kind: input.kind,
      subKind: input.subKind ?? "",
      scope: input.scope,
      scopeId: input.scopeId,
      definitionId: input.definitionId ?? null,
      visibility: input.visibility ?? "project_shared",
      contentJson: input.contentJson,
      tagsJson: input.tagsJson ?? [],
      qualityScore: input.qualityScore ?? 0.5,
      useCount: 0,
      successCount: 0,
      failCount: 0,
      decayAt: input.decayAt ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      parentId: input.parentId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      embeddingRef: input.embeddingRef ?? null,
      pinned: Boolean(input.pinned),
      metadataJson: input.metadataJson ?? {},
      createdAt: now,
      updatedAt: now,
    });

    const found = await this.findById(id);
    if (!found) {
      throw new Error(`SqliteExperienceStore.insert: row not found after insert id=${id}`);
    }
    return found;
  }

  async update(id: string, patch: UpdateExperienceInput): Promise<Experience> {
    const db = await getDb();
    const now = new Date().toISOString();

    const set: Record<string, unknown> = { updatedAt: now };
    if (patch.subKind !== undefined) set.subKind = patch.subKind;
    if (patch.contentJson !== undefined) set.contentJson = patch.contentJson;
    if (patch.tagsJson !== undefined) set.tagsJson = patch.tagsJson;
    if (patch.qualityScore !== undefined) set.qualityScore = patch.qualityScore;
    if (patch.useCount !== undefined) set.useCount = patch.useCount;
    if (patch.successCount !== undefined) set.successCount = patch.successCount;
    if (patch.failCount !== undefined) set.failCount = patch.failCount;
    if (patch.decayAt !== undefined) set.decayAt = patch.decayAt;
    if (patch.validTo !== undefined) set.validTo = patch.validTo;
    if (patch.parentId !== undefined) set.parentId = patch.parentId;
    if (patch.embeddingRef !== undefined) set.embeddingRef = patch.embeddingRef;
    if (patch.pinned !== undefined) set.pinned = patch.pinned;
    if (patch.metadataJson !== undefined) set.metadataJson = patch.metadataJson;

    await db.update(experienceTable).set(set).where(eq(experienceTable.id, id));

    const found = await this.findById(id);
    if (!found) throw new Error(`SqliteExperienceStore.update: experience ${id} not found`);
    return found;
  }

  async findById(id: string): Promise<Experience | null> {
    const db = await getDb();
    const rows = await db.select().from(experienceTable).where(eq(experienceTable.id, id)).limit(1);
    return rows[0] ? rowToExperience(rows[0]) : null;
  }

  async findManyByIds(ids: string[]): Promise<Experience[]> {
    if (ids.length === 0) return [];
    const db = await getDb();
    const rows = await db.select().from(experienceTable).where(inArray(experienceTable.id, ids));
    return rows.map(rowToExperience);
  }

  async query(filter: ExperienceQuery): Promise<Experience[]> {
    const db = await getDb();
    const conditions: SQL[] = [];

    if (filter.kind) {
      const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
      const first = kinds[0];
      if (kinds.length === 1 && first) conditions.push(eq(experienceTable.kind, first));
      else conditions.push(inArray(experienceTable.kind, kinds));
    }
    if (filter.subKind) {
      const subs = Array.isArray(filter.subKind) ? filter.subKind : [filter.subKind];
      const first = subs[0];
      if (subs.length === 1 && first !== undefined)
        conditions.push(eq(experienceTable.subKind, first));
      else conditions.push(inArray(experienceTable.subKind, subs));
    }
    if (filter.scope) conditions.push(eq(experienceTable.scope, filter.scope));
    if (filter.scopeId) conditions.push(eq(experienceTable.scopeId, filter.scopeId));
    if (filter.definitionId !== undefined) {
      if (filter.definitionId === null) {
        // 用 SQL fragment 表达 IS NULL；drizzle 没有直接的 isNull on conditions array helper here
        // 但 eq(col, null) 在 sqlite 不工作；我们用 sql template
        conditions.push(sqlIsNull(experienceTable.definitionId));
      } else {
        conditions.push(eq(experienceTable.definitionId, filter.definitionId));
      }
    }
    if (filter.pinnedOnly) conditions.push(eq(experienceTable.pinned, true));

    const archivalMode = filter.archivalMode ?? "exclude_archived";
    if (archivalMode === "exclude_archived") {
      conditions.push(sqlIsNull(experienceTable.validTo));
    } else if (archivalMode === "only_archived") {
      conditions.push(sqlIsNotNull(experienceTable.validTo));
    }

    const orderClause = (() => {
      switch (filter.orderBy ?? "valid_from_desc") {
        case "quality_desc":
          return desc(experienceTable.qualityScore);
        case "created_desc":
          return desc(experienceTable.createdAt);
        default:
          return desc(experienceTable.validFrom);
      }
    })();

    let rows = await db
      .select()
      .from(experienceTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(orderClause)
      .limit(filter.limit ?? 50)
      .offset(filter.offset ?? 0);

    // anyTags 用 JS 侧过滤（SQLite JSON1 各种 dialect 兼容性差；P1 数据量小没问题）
    if (filter.anyTags && filter.anyTags.length > 0) {
      const wanted = new Set(filter.anyTags);
      rows = rows.filter((row) => {
        const tags = normalizeJson<string[]>(row.tagsJson, []);
        return tags.some((t) => wanted.has(t));
      });
    }

    return rows.map(rowToExperience);
  }

  async linkAdd(
    fromId: string,
    toId: string,
    relation: ExperienceLink["relation"],
    weight = 1.0
  ): Promise<ExperienceLink> {
    if (fromId === toId) {
      throw new Error("ExperienceStore.linkAdd: self-link is not allowed");
    }
    const db = await getDb();
    const id = randomUUID();
    const now = new Date().toISOString();

    // 幂等：(from, to, relation) 唯一索引；冲突时直接读回去
    try {
      await db.insert(experienceLinkTable).values({
        id,
        fromId,
        toId,
        relation,
        weight,
        createdAt: now,
      });
    } catch (err) {
      // SQLite UNIQUE constraint failed → 视为幂等，读回去
      const msg = err instanceof Error ? err.message : String(err);
      if (!/UNIQUE constraint failed/i.test(msg)) throw err;
    }

    const existing = await db
      .select()
      .from(experienceLinkTable)
      .where(
        and(
          eq(experienceLinkTable.fromId, fromId),
          eq(experienceLinkTable.toId, toId),
          eq(experienceLinkTable.relation, relation)
        )
      )
      .limit(1);
    if (!existing[0]) {
      throw new Error("ExperienceStore.linkAdd: insert succeeded but row not found");
    }
    return rowToLink(existing[0]);
  }

  async linkList(experienceId: string): Promise<ExperienceLink[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(experienceLinkTable)
      .where(eq(experienceLinkTable.fromId, experienceId));
    return rows.map(rowToLink);
  }

  async linkListByEither(experienceId: string): Promise<ExperienceLink[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(experienceLinkTable)
      .where(
        sql`${experienceLinkTable.fromId} = ${experienceId} OR ${experienceLinkTable.toId} = ${experienceId}`
      );
    return rows.map(rowToLink);
  }

  async linkExpand(params: LinkExpandParams): Promise<Experience[]> {
    if (params.seedIds.length === 0) return [];
    const db = await getDb();
    const maxDepth = Math.max(1, Math.min(params.maxDepth ?? 1, 3));

    const seen = new Set<string>(params.seedIds);
    const frontier = new Set<string>(params.seedIds);

    for (let depth = 0; depth < maxDepth; depth++) {
      if (frontier.size === 0) break;
      const fromIds = Array.from(frontier);
      const conditions: SQL[] = [inArray(experienceLinkTable.fromId, fromIds)];
      if (params.relations && params.relations.length > 0) {
        conditions.push(inArray(experienceLinkTable.relation, params.relations));
      }
      const links = await db
        .select()
        .from(experienceLinkTable)
        .where(and(...conditions));
      frontier.clear();
      for (const link of links) {
        if (!seen.has(link.toId)) {
          seen.add(link.toId);
          frontier.add(link.toId);
        }
      }
    }

    // 去掉 seed 自身
    const expandedIds = Array.from(seen).filter((id) => !params.seedIds.includes(id));
    if (expandedIds.length === 0) return [];
    return this.findManyByIds(expandedIds);
  }

  async logOp(input: OpLogInput): Promise<ExperienceOpLog> {
    const db = await getDb();
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.insert(experienceOpLogTable).values({
      id,
      experienceId: input.experienceId,
      op: input.op,
      workflowRunId: input.workflowRunId ?? null,
      outcome: input.outcome ?? null,
      actor: input.actor,
      metadataJson: input.metadataJson ?? {},
      createdAt: now,
    });
    return {
      id,
      experienceId: input.experienceId,
      op: input.op,
      workflowRunId: input.workflowRunId ?? null,
      outcome: input.outcome ?? null,
      actor: input.actor,
      metadataJson: input.metadataJson ?? {},
      createdAt: now,
    };
  }

  async listOps(experienceId: string, limit = 50): Promise<ExperienceOpLog[]> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(experienceOpLogTable)
      .where(eq(experienceOpLogTable.experienceId, experienceId))
      .orderBy(asc(experienceOpLogTable.createdAt))
      .limit(limit);
    return rows.map(rowToOpLog);
  }
}

// ───────────────────────── 内存实现（用于单测 pipe，无 DB 依赖） ─────────────────────────

/**
 * 全部状态保存在内存的 Map / 数组里。覆盖与 SqliteExperienceStore 同一份接口；
 * 主要供 Writer/Extractor/Reflector/Janitor/Recall 各自单测使用，不必拉起 SQLite。
 *
 * 不保证多线程安全；测试上下文里这不是问题。
 */
export class InMemoryExperienceStore implements ExperienceStore {
  private experiences = new Map<string, Experience>();
  private links: ExperienceLink[] = [];
  private opLogs: ExperienceOpLog[] = [];

  async insert(input: InsertExperienceInput): Promise<Experience> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const row: Experience = {
      id,
      kind: input.kind,
      subKind: input.subKind ?? "",
      scope: input.scope,
      scopeId: input.scopeId,
      definitionId: input.definitionId ?? null,
      visibility: input.visibility ?? "project_shared",
      contentJson: input.contentJson,
      tagsJson: input.tagsJson ?? [],
      qualityScore: input.qualityScore ?? 0.5,
      useCount: 0,
      successCount: 0,
      failCount: 0,
      decayAt: input.decayAt ?? null,
      validFrom: input.validFrom,
      validTo: input.validTo ?? null,
      parentId: input.parentId ?? null,
      sourceRunId: input.sourceRunId ?? null,
      embeddingRef: input.embeddingRef ?? null,
      pinned: Boolean(input.pinned),
      metadataJson: input.metadataJson ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.experiences.set(id, row);
    return row;
  }

  async update(id: string, patch: UpdateExperienceInput): Promise<Experience> {
    const existing = this.experiences.get(id);
    if (!existing) throw new Error(`InMemoryExperienceStore.update: ${id} not found`);
    const next: Experience = {
      ...existing,
      ...(patch.subKind !== undefined ? { subKind: patch.subKind } : {}),
      ...(patch.contentJson !== undefined ? { contentJson: patch.contentJson } : {}),
      ...(patch.tagsJson !== undefined ? { tagsJson: patch.tagsJson } : {}),
      ...(patch.qualityScore !== undefined ? { qualityScore: patch.qualityScore } : {}),
      ...(patch.useCount !== undefined ? { useCount: patch.useCount } : {}),
      ...(patch.successCount !== undefined ? { successCount: patch.successCount } : {}),
      ...(patch.failCount !== undefined ? { failCount: patch.failCount } : {}),
      ...(patch.decayAt !== undefined ? { decayAt: patch.decayAt } : {}),
      ...(patch.validTo !== undefined ? { validTo: patch.validTo } : {}),
      ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
      ...(patch.embeddingRef !== undefined ? { embeddingRef: patch.embeddingRef } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      ...(patch.metadataJson !== undefined ? { metadataJson: patch.metadataJson } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.experiences.set(id, next);
    return next;
  }

  async findById(id: string): Promise<Experience | null> {
    return this.experiences.get(id) ?? null;
  }

  async findManyByIds(ids: string[]): Promise<Experience[]> {
    return ids.map((id) => this.experiences.get(id)).filter((x): x is Experience => Boolean(x));
  }

  async query(filter: ExperienceQuery): Promise<Experience[]> {
    let rows = Array.from(this.experiences.values());

    if (filter.kind) {
      const kinds = new Set(Array.isArray(filter.kind) ? filter.kind : [filter.kind]);
      rows = rows.filter((r) => kinds.has(r.kind));
    }
    if (filter.subKind) {
      const subs = new Set(Array.isArray(filter.subKind) ? filter.subKind : [filter.subKind]);
      rows = rows.filter((r) => subs.has(r.subKind));
    }
    if (filter.scope) rows = rows.filter((r) => r.scope === filter.scope);
    if (filter.scopeId) rows = rows.filter((r) => r.scopeId === filter.scopeId);
    if (filter.definitionId !== undefined) {
      rows = rows.filter((r) => r.definitionId === filter.definitionId);
    }
    if (filter.pinnedOnly) rows = rows.filter((r) => r.pinned);

    const archivalMode = filter.archivalMode ?? "exclude_archived";
    if (archivalMode === "exclude_archived") rows = rows.filter((r) => r.validTo === null);
    if (archivalMode === "only_archived") rows = rows.filter((r) => r.validTo !== null);

    if (filter.anyTags && filter.anyTags.length > 0) {
      const wanted = new Set(filter.anyTags);
      rows = rows.filter((r) => r.tagsJson.some((t) => wanted.has(t)));
    }

    rows.sort((a, b) => {
      switch (filter.orderBy ?? "valid_from_desc") {
        case "quality_desc":
          return b.qualityScore - a.qualityScore;
        case "created_desc":
          return b.createdAt.localeCompare(a.createdAt);
        default:
          return b.validFrom.localeCompare(a.validFrom);
      }
    });

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return rows.slice(offset, offset + limit);
  }

  async linkAdd(
    fromId: string,
    toId: string,
    relation: ExperienceLink["relation"],
    weight = 1.0
  ): Promise<ExperienceLink> {
    if (fromId === toId) throw new Error("self-link not allowed");
    const dup = this.links.find(
      (l) => l.fromId === fromId && l.toId === toId && l.relation === relation
    );
    if (dup) return dup;
    const link: ExperienceLink = {
      id: randomUUID(),
      fromId,
      toId,
      relation,
      weight,
      createdAt: new Date().toISOString(),
    };
    this.links.push(link);
    return link;
  }

  async linkList(experienceId: string): Promise<ExperienceLink[]> {
    return this.links.filter((l) => l.fromId === experienceId);
  }

  async linkListByEither(experienceId: string): Promise<ExperienceLink[]> {
    return this.links.filter((l) => l.fromId === experienceId || l.toId === experienceId);
  }

  async linkExpand(params: LinkExpandParams): Promise<Experience[]> {
    if (params.seedIds.length === 0) return [];
    const maxDepth = Math.max(1, Math.min(params.maxDepth ?? 1, 3));
    const wantedRel = params.relations ? new Set(params.relations) : null;

    const seen = new Set<string>(params.seedIds);
    let frontier = new Set<string>(params.seedIds);
    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Set<string>();
      for (const link of this.links) {
        if (!frontier.has(link.fromId)) continue;
        if (wantedRel && !wantedRel.has(link.relation)) continue;
        if (!seen.has(link.toId)) {
          seen.add(link.toId);
          next.add(link.toId);
        }
      }
      frontier = next;
      if (frontier.size === 0) break;
    }
    const expandedIds = Array.from(seen).filter((id) => !params.seedIds.includes(id));
    return this.findManyByIds(expandedIds);
  }

  async logOp(input: OpLogInput): Promise<ExperienceOpLog> {
    const log: ExperienceOpLog = {
      id: randomUUID(),
      experienceId: input.experienceId,
      op: input.op,
      workflowRunId: input.workflowRunId ?? null,
      outcome: input.outcome ?? null,
      actor: input.actor,
      metadataJson: input.metadataJson ?? {},
      createdAt: new Date().toISOString(),
    };
    this.opLogs.push(log);
    return log;
  }

  async listOps(experienceId: string, limit = 50): Promise<ExperienceOpLog[]> {
    return this.opLogs.filter((o) => o.experienceId === experienceId).slice(-limit);
  }
}

// ───────────────────────── 默认实例 & 工厂 ─────────────────────────

let _default: ExperienceStore | null = null;

/** 生产入口；其它模块拿这个就行（除了单测）。 */
export function getExperienceStore(): ExperienceStore {
  if (!_default) _default = new SqliteExperienceStore();
  return _default;
}

/** 仅供测试或边界用例覆盖默认实现。 */
export function setExperienceStoreForTesting(store: ExperienceStore | null): void {
  _default = store;
}

// ───────────────────────── 内部 SQL helper ─────────────────────────
// drizzle 当前版本里 `eq(col, null)` 在 SQLite 不生效，需要手写 IS NULL / IS NOT NULL 片段。

type AnyColumn = Parameters<typeof eq>[0];

function sqlIsNull(col: AnyColumn): SQL {
  return sql`${col} IS NULL`;
}

function sqlIsNotNull(col: AnyColumn): SQL {
  return sql`${col} IS NOT NULL`;
}
