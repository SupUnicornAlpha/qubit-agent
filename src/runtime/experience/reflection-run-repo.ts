/**
 * ReflectionRunRepo — Memory V2 P1 反思留痕的"二级 Store"
 *
 * 为什么不直接塞进 ExperienceStore：
 *   - reflection_run 与 experience 是**不同生命周期实体**（前者按工作流粒度、后者按经验体粒度）
 *   - 把它合进 ExperienceStore 会把后者的接口撑成 8 个方法以上；分开维持单一职责
 *
 * 两种实现：
 *   - `SqliteReflectionRunRepo`：生产 / 集成测试用
 *   - `InMemoryReflectionRunRepo`：Reflector pipe 单测用，零 DB 依赖
 *
 * 设计原则与 ExperienceStore 一致：只做 CRUD + 几个针对反思场景的过滤查询
 * （findRecentBySignature / sumDailyBudgetUsed），不做业务判断。
 */

import { randomUUID } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { reflectionRun as reflectionRunTable } from "../../db/sqlite/schema";
import type { ReflectionScope, ReflectionStatus } from "../../types/entities";

// ───────────────────────── 接口契约 ─────────────────────────

export interface ReflectionInsertInput {
  scope: ReflectionScope;
  subjectRunId: string;
  definitionId?: string | null;
  failureSignature?: string | null;
  status: ReflectionStatus;
  errorMessage?: string;
  now: Date;
}

export interface ReflectionUpdatePatch {
  status?: ReflectionStatus;
  budgetTokensUsed?: number;
  producedExperienceIdsJson?: string[];
  errorMessage?: string;
  endedAt?: string;
}

export interface ReflectionRunRepo {
  insert(input: ReflectionInsertInput): Promise<{
    runId: string;
    status: ReflectionStatus;
  }>;
  update(id: string, patch: ReflectionUpdatePatch): Promise<void>;
  /**
   * 在 [now - windowMs, now] 时间窗内查找 failure_signature 相同且
   * status ∈ {running, completed} 的最近一条；找到说明"已反思过"。
   */
  findRecentBySignature(
    signature: string,
    now: Date,
    windowMs: number
  ): Promise<{ id: string } | null>;
  /**
   * 当日（now 所在自然日 00:00 起）某 project 已经消耗的反思 token 总量。
   * P1 通过 failure_signature 前缀 `${projectId}|...` 关联；
   * P2 reflection_run 加 projectId 字段后改字段直接查。
   */
  sumDailyBudgetUsed(projectId: string, now: Date): Promise<number>;
}

// ───────────────────────── Sqlite 实现 ─────────────────────────

export class SqliteReflectionRunRepo implements ReflectionRunRepo {
  async insert(input: ReflectionInsertInput) {
    const db = await getDb();
    const id = randomUUID();
    await db.insert(reflectionRunTable).values({
      id,
      scope: input.scope,
      subjectRunId: input.subjectRunId,
      definitionId: input.definitionId ?? null,
      failureSignature: input.failureSignature ?? null,
      status: input.status,
      budgetTokensUsed: 0,
      producedExperienceIdsJson: [],
      errorMessage: input.errorMessage ?? null,
      startedAt: input.now.toISOString(),
      endedAt: input.status === "running" ? null : input.now.toISOString(),
    });
    return { runId: id, status: input.status };
  }

  async update(id: string, patch: ReflectionUpdatePatch): Promise<void> {
    const db = await getDb();
    const set: Record<string, unknown> = {};
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.budgetTokensUsed !== undefined) set.budgetTokensUsed = patch.budgetTokensUsed;
    if (patch.producedExperienceIdsJson !== undefined)
      set.producedExperienceIdsJson = patch.producedExperienceIdsJson;
    if (patch.errorMessage !== undefined) set.errorMessage = patch.errorMessage;
    if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
    if (Object.keys(set).length === 0) return;
    await db.update(reflectionRunTable).set(set).where(eq(reflectionRunTable.id, id));
  }

  async findRecentBySignature(
    signature: string,
    now: Date,
    windowMs: number
  ): Promise<{ id: string } | null> {
    const db = await getDb();
    const cutoff = new Date(now.getTime() - windowMs).toISOString();
    const rows = await db
      .select({ id: reflectionRunTable.id })
      .from(reflectionRunTable)
      .where(
        and(
          eq(reflectionRunTable.failureSignature, signature),
          gte(reflectionRunTable.startedAt, cutoff),
          sql`${reflectionRunTable.status} IN ('running','completed')`
        )
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async sumDailyBudgetUsed(projectId: string, now: Date): Promise<number> {
    const db = await getDb();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const rows = await db
      .select({ used: reflectionRunTable.budgetTokensUsed })
      .from(reflectionRunTable)
      .where(
        and(
          gte(reflectionRunTable.startedAt, todayStart.toISOString()),
          sql`${reflectionRunTable.failureSignature} LIKE ${`${projectId}|%`}`
        )
      );
    return rows.reduce((sum, r) => sum + (r.used ?? 0), 0);
  }
}

// ───────────────────────── InMemory 实现 ─────────────────────────

interface InMemoryRow {
  id: string;
  scope: ReflectionScope;
  subjectRunId: string;
  definitionId: string | null;
  failureSignature: string | null;
  status: ReflectionStatus;
  budgetTokensUsed: number;
  producedExperienceIdsJson: string[];
  errorMessage: string | null;
  startedAt: string;
  endedAt: string | null;
}

export class InMemoryReflectionRunRepo implements ReflectionRunRepo {
  rows: InMemoryRow[] = [];

  async insert(input: ReflectionInsertInput) {
    const id = randomUUID();
    this.rows.push({
      id,
      scope: input.scope,
      subjectRunId: input.subjectRunId,
      definitionId: input.definitionId ?? null,
      failureSignature: input.failureSignature ?? null,
      status: input.status,
      budgetTokensUsed: 0,
      producedExperienceIdsJson: [],
      errorMessage: input.errorMessage ?? null,
      startedAt: input.now.toISOString(),
      endedAt: input.status === "running" ? null : input.now.toISOString(),
    });
    return { runId: id, status: input.status };
  }

  async update(id: string, patch: ReflectionUpdatePatch): Promise<void> {
    const idx = this.rows.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const r = this.rows[idx];
    if (!r) return;
    if (patch.status !== undefined) r.status = patch.status;
    if (patch.budgetTokensUsed !== undefined) r.budgetTokensUsed = patch.budgetTokensUsed;
    if (patch.producedExperienceIdsJson !== undefined)
      r.producedExperienceIdsJson = patch.producedExperienceIdsJson;
    if (patch.errorMessage !== undefined) r.errorMessage = patch.errorMessage;
    if (patch.endedAt !== undefined) r.endedAt = patch.endedAt;
  }

  async findRecentBySignature(
    signature: string,
    now: Date,
    windowMs: number
  ): Promise<{ id: string } | null> {
    const cutoff = now.getTime() - windowMs;
    for (const r of this.rows) {
      if (r.failureSignature !== signature) continue;
      if (r.status !== "running" && r.status !== "completed") continue;
      if (new Date(r.startedAt).getTime() < cutoff) continue;
      return { id: r.id };
    }
    return null;
  }

  async sumDailyBudgetUsed(projectId: string, now: Date): Promise<number> {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const cutoff = todayStart.getTime();
    let sum = 0;
    const prefix = `${projectId}|`;
    for (const r of this.rows) {
      if (!r.failureSignature || !r.failureSignature.startsWith(prefix)) continue;
      if (new Date(r.startedAt).getTime() < cutoff) continue;
      sum += r.budgetTokensUsed;
    }
    return sum;
  }
}

// ───────────────────────── 默认实例 & 工厂 ─────────────────────────

let _default: ReflectionRunRepo | null = null;

export function getReflectionRunRepo(): ReflectionRunRepo {
  if (!_default) _default = new SqliteReflectionRunRepo();
  return _default;
}

export function setReflectionRunRepoForTesting(repo: ReflectionRunRepo | null): void {
  _default = repo;
}
