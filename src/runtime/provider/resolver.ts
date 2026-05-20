/**
 * ProviderResolver：按 scope + 优先级链解析 Provider
 *
 * 解析优先级（§5.4.4）：
 *   1. 显式 override（API 调用时指定 providerKey/Id）
 *   2. provider_binding.scope='strategy_version'
 *   3. provider_binding.scope='workflow'
 *   4. provider_binding.scope='project'
 *   5. provider_binding.scope='global'
 *   6. registry priority 最高的 enabled Provider
 *   7. fallback Provider（is_fallback=true）
 *
 * 业务代码示例：
 *   const provider = await providerResolver.resolve('factor_compute', { projectId });
 *   await provider.compute({...});
 */

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { providerBinding, providerRegistry as providerRegistryTable } from "../../db/sqlite/schema";
import { providerRegistry } from "./registry";
import {
  type BaseProvider,
  type ProviderKind,
  type ProviderKindMap,
  type ProviderScope,
  ProviderError,
} from "./types";

export interface ResolveOptions {
  /** 显式指定 providerKey（最高优先级，跳过 binding） */
  providerKey?: string;
  /** 显式指定 DB 主键（最高优先级，跳过 binding） */
  providerId?: string;
  /** 跳过 fallback；默认 false（即缺主 Provider 时返回 fallback） */
  skipFallback?: boolean;
}

class ProviderResolver {
  /**
   * 解析 Provider 实例
   * @throws ProviderError(no_fallback) 当链路全空且 skipFallback=true
   */
  async resolve<K extends ProviderKind>(
    kind: K,
    scope: ProviderScope = {},
    options: ResolveOptions = {}
  ): Promise<ProviderKindMap[K]> {
    // 1. 显式 providerKey
    if (options.providerKey) {
      const p = providerRegistry.get<ProviderKindMap[K]>(kind, options.providerKey);
      if (p) return p;
      throw new ProviderError(
        "not_found",
        `Provider ${kind}:${options.providerKey} not registered`
      );
    }

    // 2. 显式 providerId（查 DB → providerKey → registry）
    if (options.providerId) {
      const db = await getDb();
      const rows = await db
        .select()
        .from(providerRegistryTable)
        .where(eq(providerRegistryTable.id, options.providerId))
        .limit(1);
      const row = rows[0];
      if (row && row.kind === kind) {
        const p = providerRegistry.get<ProviderKindMap[K]>(kind, row.providerKey);
        if (p) return p;
      }
      throw new ProviderError("not_found", `Provider id=${options.providerId} not found or kind mismatch`);
    }

    // 3-6. 走 binding 优先级链
    const fromBinding = await this.resolveFromBinding<K>(kind, scope);
    if (fromBinding) return fromBinding;

    // 6. registry priority 最高 enabled
    const def = providerRegistry.pickDefault<ProviderKindMap[K]>(kind);
    if (def) return def;

    // 7. fallback
    if (!options.skipFallback) {
      const fb = providerRegistry.pickFallback<ProviderKindMap[K]>(kind);
      if (fb) return fb;
    }

    throw new ProviderError(
      "no_fallback",
      `No provider available for kind=${kind}`,
      { kind, scope }
    );
  }

  /** 列出某 kind 下所有可用 Provider（含禁用，便于 UI 渲染） */
  async list(kind: ProviderKind, opts?: { includeDisabled?: boolean }) {
    return providerRegistry.list(
      kind,
      opts?.includeDisabled !== undefined ? { includeDisabled: opts.includeDisabled } : undefined
    );
  }

  /** 检查 capability：业务侧据此决定是否启动某场景 */
  async checkCapabilities(
    requirements: Array<{ kind: ProviderKind; level: "required" | "optional" }>,
    scope: ProviderScope = {}
  ): Promise<{
    ok: boolean;
    missing: Array<{ kind: ProviderKind; reason: string }>;
  }> {
    const missing: Array<{ kind: ProviderKind; reason: string }> = [];
    for (const req of requirements) {
      try {
        await this.resolve(req.kind, scope, { skipFallback: req.level === "required" });
      } catch (e) {
        if (req.level === "required") {
          missing.push({ kind: req.kind, reason: (e as Error).message });
        }
      }
    }
    return { ok: missing.length === 0, missing };
  }

  // ── private ──

  private async resolveFromBinding<K extends ProviderKind>(
    kind: K,
    scope: ProviderScope
  ): Promise<ProviderKindMap[K] | null> {
    const order: Array<{
      scope: "strategy_version" | "workflow" | "project" | "global";
      scopeId?: string;
    }> = [];
    if (scope.strategyVersionId) {
      order.push({ scope: "strategy_version", scopeId: scope.strategyVersionId });
    }
    if (scope.workflowRunId) {
      order.push({ scope: "workflow", scopeId: scope.workflowRunId });
    }
    if (scope.projectId) {
      order.push({ scope: "project", scopeId: scope.projectId });
    }
    order.push({ scope: "global" });
    const db = await getDb();
    for (const layer of order) {
      if (layer.scope !== "global" && !layer.scopeId) continue;
      const rows = await db
        .select({
          providerKey: providerRegistryTable.providerKey,
          status: providerRegistryTable.status,
        })
        .from(providerBinding)
        .innerJoin(
          providerRegistryTable,
          eq(providerBinding.providerId, providerRegistryTable.id)
        )
        .where(
          and(
            eq(providerBinding.scope, layer.scope),
            layer.scope === "global"
              ? eq(providerBinding.scopeId, "")
              : eq(providerBinding.scopeId, layer.scopeId!),
            eq(providerBinding.kind, kind)
          )
        )
        .limit(1);
      const row = rows[0];
      if (row && row.status === "enabled") {
        const p = providerRegistry.get<ProviderKindMap[K]>(kind, row.providerKey);
        if (p) return p;
      }
    }
    return null;
  }
}

export const providerResolver = new ProviderResolver();
