import type {
  ConnectorConfig,
  ConnectorMeta,
  HealthCheckResult,
  MemoryFilters,
  MemoryMetadata,
  MemoryRecord,
} from "../../../types/connector";
import { BaseMemoryConnector } from "../memory.connector";
import { longtermStore } from "./longterm.store";
import { midtermStore } from "./midterm.store";
import { sessionStore } from "./session.store";

/**
 * NativeMemoryConnector — always-on memory connector backed by:
 *   - SQLite (session / midterm / longterm metadata)
 *   - LanceDB (longterm vector embeddings)
 *   - Local FS (artifact snapshots)
 *
 * This connector is always active regardless of external memory configuration.
 */
export class NativeMemoryConnector extends BaseMemoryConnector {
  readonly meta: ConnectorMeta = {
    name: "native-memory",
    version: "1.0.0",
    connectorType: "memory",
    capabilities: ["session", "midterm", "longterm", "vector_search"],
    assetClasses: [],
    latencyProfile: "neartime",
    description: "Built-in memory store: SQLite + LanceDB + FS. Zero external dependencies.",
  };

  protected async onInit(_config: ConnectorConfig): Promise<void> {
    // SQLite and LanceDB clients are lazy-initialized on first use
  }

  protected async onHealthcheck(): Promise<Omit<HealthCheckResult, "latencyMs" | "checkedAt">> {
    try {
      const { getDb } = await import("../../../db/sqlite/client");
      await getDb();
      return { status: "healthy" };
    } catch (err) {
      return {
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  protected async onShutdown(): Promise<void> {
    // SQLite connection cleanup is handled by the db module
  }

  async add(content: string, metadata: MemoryMetadata): Promise<MemoryRecord> {
    /**
     * Bug B1 修复（Memory V2 P0）：
     *
     * 旧实现 `const id = crypto.randomUUID()` 与 `sessionStore.upsert` / `midtermStore.insert`
     * / `longtermStore.insert` 各自内部生成的 id **完全无关** —— 返回给 `write_memory` 工具的
     * `memoryId` 在 DB 里查不到，Agent 后续若想引用 / 删除该条目都会失败。
     *
     * 现在我们把 store 真正落库的 id 透传出去。session 层因为是 upsert（一个 workflow 只一行）
     * 取 `sessionMemory.id`；midterm/longterm 各自取自己 insert 返回的 id。
     */
    const now = new Date().toISOString();

    if (metadata.layer === "session" && metadata["workflowRunId"]) {
      const row = await sessionStore.upsert(metadata["workflowRunId"] as string, {
        summary: content,
        stateJson: metadata,
        asofTime: metadata.asofTime,
      });
      return {
        id: row.id,
        content,
        metadata,
        createdAt: row.updatedAt ?? now,
        updatedAt: row.updatedAt ?? now,
      };
    }

    if (metadata.layer === "midterm" && metadata.projectId) {
      const row = await midtermStore.insert({
        projectId: metadata.projectId,
        definitionId: typeof metadata.definitionId === "string" ? metadata.definitionId : null,
        memoryType: ((metadata["memoryType"] as string) ?? "strategy_iteration") as never,
        contentJson: { content, ...metadata },
        timeWindowStart: (metadata["timeWindowStart"] as string) ?? now,
        timeWindowEnd: (metadata["timeWindowEnd"] as string) ?? now,
        asofTime: metadata.asofTime,
        score: (metadata["score"] as number) ?? null,
      });
      return {
        id: row.id,
        content,
        metadata,
        createdAt: row.updatedAt ?? now,
        updatedAt: row.updatedAt ?? now,
      };
    }

    const row = await longtermStore.insert({
      scope: ((metadata["scope"] as string) ?? "project") as never,
      scopeId: metadata.projectId ?? metadata.strategyId ?? "default",
      definitionId: typeof metadata.definitionId === "string" ? metadata.definitionId : null,
      memoryType: ((metadata["memoryType"] as string) ?? "playbook") as never,
      contentJson: { content, ...metadata },
      embeddingRef: null,
      artifactUri: null,
      validFrom: metadata.asofTime,
      validTo: null,
      asofTime: metadata.asofTime,
      confidenceScore: (metadata["confidenceScore"] as number) ?? null,
    });
    return {
      id: row.id,
      content,
      metadata,
      createdAt: row.updatedAt ?? now,
      updatedAt: row.updatedAt ?? now,
    };
  }

  async search(query: string, filters: MemoryFilters, topK: number): Promise<MemoryRecord[]> {
    /**
     * Bug B2 修复（Memory V2 P0）：
     *
     * 旧实现完全忽略 `query` 参数，行为等价于 `list_longterm` —— 调用方按工具描述
     * "按关键词检索"被误导，拿到 N 条不相关的 longterm 全表项。
     *
     * 这一版做 3 件事：
     *   1) `filters.layer` 决定查哪张表（默认 longterm，兼容旧 caller）；
     *   2) 用 contentJson 的 JSON-stringify 做大小写不敏感的子串匹配（V1 关键词召回）；
     *      没设 query 时退化为按 recency 取 topK，与旧 list 等价；
     *   3) 给每条结果算一个 0~1 的 keyword score，让 caller 能做后续排序 / 过滤。
     *
     * 注：完整语义检索 + JSON path 过滤是 Memory V2 P1 的 ExperienceRecall 模块的职责，
     * 这里只把"假装"的搜索改成"能用"的搜索，避免回归。
     */
    const layer = (filters.layer ?? "longterm") as "longterm" | "midterm" | "session";
    const wanted = query.trim().toLowerCase();
    const limitForScan = Math.max(topK * 4, 50); // 取多一些再按 keyword 二次过滤

    if (layer === "midterm") {
      if (!filters.projectId) return [];
      const rows = await midtermStore.query({
        projectId: filters.projectId,
        ...(filters.definitionId ? { definitionId: filters.definitionId } : {}),
        limit: limitForScan,
      });
      return scoreAndTake(
        rows.map((r) => ({
          id: r.id,
          content: JSON.stringify(r.contentJson),
          metadata: {
            layer: "midterm" as const,
            asofTime: r.asofTime,
            projectId: filters.projectId,
          },
          score: r.score ?? undefined,
          createdAt: r.updatedAt,
          updatedAt: r.updatedAt,
        })),
        wanted,
        topK
      );
    }

    // 默认 longterm
    const rows = await longtermStore.query({
      ...(filters.projectId ? { scopeId: filters.projectId } : {}),
      ...(filters.definitionId ? { definitionId: filters.definitionId } : {}),
      limit: limitForScan,
    });
    return scoreAndTake(
      rows.map((r) => ({
        id: r.id,
        content: JSON.stringify(r.contentJson),
        metadata: {
          layer: "longterm" as const,
          asofTime: r.asofTime,
          projectId: filters.projectId,
        },
        score: r.confidenceScore ?? undefined,
        createdAt: r.updatedAt,
        updatedAt: r.updatedAt,
      })),
      wanted,
      topK
    );
  }

  async get(id: string): Promise<MemoryRecord | null> {
    // Try all layers
    const rows = await longtermStore.query({ limit: 1 });
    const row = rows.find((r) => r.id === id);
    if (!row) return null;

    return {
      id: row.id,
      content: JSON.stringify(row.contentJson),
      metadata: {
        layer: "longterm",
        asofTime: row.asofTime,
      },
      createdAt: row.updatedAt,
      updatedAt: row.updatedAt,
    };
  }

  async delete(id: string): Promise<void> {
    await longtermStore.delete(id);
  }

  async list(filters: MemoryFilters): Promise<MemoryRecord[]> {
    return this.search("", filters, 100);
  }
}

export const nativeMemoryConnector = new NativeMemoryConnector();

/**
 * 关键词召回 V1：把每条记录的内容做 lower-case 子串匹配，给一个 0~1 的命中分。
 *
 * - query 为空 → 按 updatedAt desc 取 topK（兼容旧 list 行为）。
 * - 命中分 = 命中 token 数 / 总 token 数（token = 空白拆分）；同样按命中分 desc 取 topK，
 *   再用 caller 原本可能带的 confidence/score 作为 tie-breaker。
 *
 * 注意：这只是 P0 阶段把 "假搜索" 改成 "能用的搜索"。完整召回（含 visibility 路由、
 * link 扩展、JSON path 过滤）在 P1 的 `ExperienceRecall` 模块。
 */
function scoreAndTake(records: MemoryRecord[], wanted: string, topK: number): MemoryRecord[] {
  if (!wanted) {
    return records
      .slice()
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, topK);
  }
  const tokens = wanted.split(/\s+/).filter((t) => t.length >= 2);
  if (tokens.length === 0) return records.slice(0, topK);

  type Scored = { record: MemoryRecord; hitScore: number; tieBreak: number };
  const scored: Scored[] = [];
  for (const r of records) {
    const haystack = r.content.toLowerCase();
    let hits = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) hits += 1;
    }
    if (hits === 0) continue;
    scored.push({
      record: r,
      hitScore: hits / tokens.length,
      tieBreak: r.score ?? 0,
    });
  }

  scored.sort((a, b) => {
    if (b.hitScore !== a.hitScore) return b.hitScore - a.hitScore;
    if (b.tieBreak !== a.tieBreak) return b.tieBreak - a.tieBreak;
    return a.record.updatedAt < b.record.updatedAt ? 1 : -1;
  });

  return scored.slice(0, topK).map((s) => ({
    ...s.record,
    score: s.hitScore, // 用命中分覆盖；caller 想看原 confidence 可看 metadata
  }));
}
