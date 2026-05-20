/**
 * ProviderRegistry：单例注册中心
 *
 * - 进程启动时由 bootstrap.ts 注册所有内置实现
 * - DB `provider_registry` 表是真相，runtime 内存索引是缓存
 * - status / priority 变更后调用 reload() 让业务侧下次 resolve 看到新顺序
 *
 * 详见 docs/FACTOR_RULE_STRATEGY_DESIGN.md §5.4
 */

import { randomUUID } from "node:crypto";
import { and, eq, desc } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { providerRegistry as providerRegistryTable } from "../../db/sqlite/schema";
import {
  type BaseProvider,
  type ProviderKind,
  ProviderError,
} from "./types";

type RegistryEntry = {
  provider: BaseProvider;
  /** DB 记录的主键（registerOrSyncToDb 后写入） */
  dbId?: string;
  /** DB 同步缓存 */
  status: "enabled" | "disabled";
  priority: number;
};

class ProviderRegistry {
  private byKey = new Map<string, RegistryEntry>(); // "{kind}:{providerKey}" → entry

  private keyOf(kind: ProviderKind, providerKey: string): string {
    return `${kind}:${providerKey}`;
  }

  /**
   * 注册 Provider 实例（内存）。一般由 bootstrap 调用。
   * 不会立即写 DB；调用 syncToDb() 把状态/优先级 upsert 到 provider_registry。
   */
  register(provider: BaseProvider): void {
    const k = this.keyOf(provider.meta.kind, provider.meta.key);
    if (this.byKey.has(k)) {
      throw new ProviderError(
        "validation_failed",
        `Provider already registered: ${k}`
      );
    }
    this.byKey.set(k, {
      provider,
      status: "enabled",
      priority: provider.meta.isFallback ? 10 : 50,
    });
  }

  unregister(kind: ProviderKind, providerKey: string): void {
    this.byKey.delete(this.keyOf(kind, providerKey));
  }

  /** 列出某 kind 的所有 Provider（不含 disabled） */
  list(
    kind: ProviderKind,
    filter?: { includeDisabled?: boolean }
  ): Array<{
    provider: BaseProvider;
    status: "enabled" | "disabled";
    priority: number;
  }> {
    const out: Array<{
      provider: BaseProvider;
      status: "enabled" | "disabled";
      priority: number;
    }> = [];
    for (const [k, entry] of this.byKey) {
      if (!k.startsWith(`${kind}:`)) continue;
      if (!filter?.includeDisabled && entry.status === "disabled") continue;
      out.push({
        provider: entry.provider,
        status: entry.status,
        priority: entry.priority,
      });
    }
    // priority 高 → 前；同 priority 按 key 字典序保证确定性
    out.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.provider.meta.key.localeCompare(b.provider.meta.key);
    });
    return out;
  }

  get<T extends BaseProvider = BaseProvider>(
    kind: ProviderKind,
    providerKey: string
  ): T | null {
    const entry = this.byKey.get(this.keyOf(kind, providerKey));
    return (entry?.provider as T) ?? null;
  }

  /** 强制返回某个 kind 下 priority 最高的 enabled provider；用作默认解析 */
  pickDefault<T extends BaseProvider = BaseProvider>(kind: ProviderKind): T | null {
    const list = this.list(kind);
    return (list[0]?.provider as T) ?? null;
  }

  /** 强制返回某个 kind 下的 fallback provider；任何 kind 至少需要 1 个 */
  pickFallback<T extends BaseProvider = BaseProvider>(kind: ProviderKind): T | null {
    for (const { provider } of this.list(kind, { includeDisabled: true })) {
      if (provider.meta.isFallback) return provider as T;
    }
    return null;
  }

  /** 内存 → DB：把当前注册的内置 Provider upsert 到 provider_registry 表 */
  async syncToDb(): Promise<void> {
    const db = await getDb();
    for (const [k, entry] of this.byKey) {
      const [kindStr, providerKey] = k.split(":") as [ProviderKind, string];
      const existing = await db
        .select()
        .from(providerRegistryTable)
        .where(
          and(
            eq(providerRegistryTable.kind, kindStr),
            eq(providerRegistryTable.providerKey, providerKey)
          )
        )
        .limit(1);

      if (existing[0]) {
        entry.dbId = existing[0].id;
        entry.status = existing[0].status as "enabled" | "disabled";
        entry.priority = existing[0].priority;
        await db
          .update(providerRegistryTable)
          .set({
            displayName: entry.provider.meta.displayName,
            description: entry.provider.meta.description ?? "",
            capabilityJson: entry.provider.meta.capability as never,
            version: entry.provider.meta.version,
            isBuiltin: entry.provider.meta.isBuiltin ?? false,
            isFallback: entry.provider.meta.isFallback ?? false,
            updatedAt: new Date().toISOString(),
          })
          .where(eq(providerRegistryTable.id, existing[0].id));
      } else {
        const newId = randomUUID();
        entry.dbId = newId;
        await db.insert(providerRegistryTable).values({
          id: newId,
          kind: kindStr,
          providerKey,
          displayName: entry.provider.meta.displayName,
          description: entry.provider.meta.description ?? "",
          capabilityJson: entry.provider.meta.capability as never,
          configJson: {} as never,
          status: "enabled",
          priority: entry.provider.meta.isFallback ? 10 : 50,
          version: entry.provider.meta.version,
          isBuiltin: entry.provider.meta.isBuiltin ?? false,
          isFallback: entry.provider.meta.isFallback ?? false,
        });
      }
    }
  }

  /** DB → 内存：把 status / priority 重新拉一遍（不重新注册 Provider 实例） */
  async reload(): Promise<void> {
    const db = await getDb();
    const rows = await db
      .select()
      .from(providerRegistryTable)
      .orderBy(desc(providerRegistryTable.priority));
    const byKey = new Map<string, { status: "enabled" | "disabled"; priority: number; dbId: string }>();
    for (const r of rows) {
      byKey.set(`${r.kind}:${r.providerKey}`, {
        status: r.status as "enabled" | "disabled",
        priority: r.priority,
        dbId: r.id,
      });
    }
    for (const [k, entry] of this.byKey) {
      const v = byKey.get(k);
      if (v) {
        entry.status = v.status;
        entry.priority = v.priority;
        entry.dbId = v.dbId;
      }
    }
  }

  /** 仅供测试 / 重启场景；清空内存（不动 DB） */
  _resetForTests(): void {
    this.byKey.clear();
  }
}

export const providerRegistry = new ProviderRegistry();
