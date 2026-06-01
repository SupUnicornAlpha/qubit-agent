/**
 * env_registry CRUD —— 提供给路由层 / 前端 EnvRegistryEditor.tsx。
 *
 * 业务规则（决议 §10.5 / §10.6）：
 *   - is_builtin=true 的项不能 DELETE；只能 disabled。后端在 `deleteRegistry`
 *     里直接拒绝（throw EnvRegistryError("builtin_protected")）。
 *   - user 自建项（is_builtin=false, source=user）：CRUD 完全开放。
 *   - kind 仅允许 'python' | 'npm'；不开放 HTTP/WS MCP 写入此表。
 *   - effectiveVersionSpec = userVersionSpec ?? versionSpec（service 层算，
 *     避免每个调用方各算各的）。
 *
 * 排序：默认 (kind ASC, capability ASC, name ASC)。
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { envRegistry } from "../../db/sqlite/schema";
import type {
  EnvKind,
  EnvSource,
  EnvStatus,
  ExpectedPackage,
} from "./types";

export class EnvRegistryError extends Error {
  constructor(public readonly code: EnvRegistryErrorCode, message?: string) {
    super(message ?? code);
    this.name = "EnvRegistryError";
  }
}

export type EnvRegistryErrorCode =
  | "not_found"
  | "builtin_protected"
  | "duplicate"
  | "invalid_kind"
  | "invalid_field";

export interface ListFilter {
  kind?: EnvKind;
  status?: EnvStatus;
  capability?: string;
}

export interface CreateUserItemInput {
  kind: EnvKind;
  packageName: string;
  displayName: string;
  description?: string;
  versionSpec?: string | null;
  optional?: boolean;
  capability?: string;
}

export interface UpdateRegistryInput {
  status?: EnvStatus;
  userVersionSpec?: string | null;
  /** 用户自建项可改 displayName / description / optional / capability；
   *  系统项仅 service 层 seed 可改这些 —— UI 走这条路径会被忽略（保留 system 值）。 */
  displayName?: string;
  description?: string;
  optional?: boolean;
  capability?: string;
}

type EnvRegistryRow = typeof envRegistry.$inferSelect;

function toExpected(row: EnvRegistryRow): ExpectedPackage {
  const extra =
    row.extraJson && typeof row.extraJson === "object"
      ? (row.extraJson as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    kind: row.kind as EnvKind,
    name: row.packageName,
    displayName: row.displayName,
    description: row.description,
    versionSpec: row.versionSpec ?? null,
    userVersionSpec: row.userVersionSpec ?? null,
    effectiveVersionSpec: row.userVersionSpec ?? row.versionSpec ?? null,
    optional: !!row.optional,
    capability: row.capability,
    source: row.source as EnvSource,
    status: row.status as EnvStatus,
    isBuiltin: !!row.isBuiltin,
    extra,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const envRegistryService = {
  async list(filter: ListFilter = {}): Promise<ExpectedPackage[]> {
    const db = await getDb();
    const conditions = [];
    if (filter.kind) conditions.push(eq(envRegistry.kind, filter.kind));
    if (filter.status) conditions.push(eq(envRegistry.status, filter.status));
    if (filter.capability)
      conditions.push(eq(envRegistry.capability, filter.capability));
    const rows = await (conditions.length
      ? db.select().from(envRegistry).where(and(...conditions))
      : db.select().from(envRegistry));
    return rows
      .map(toExpected)
      .sort(
        (a, b) =>
          a.kind.localeCompare(b.kind) ||
          a.capability.localeCompare(b.capability) ||
          a.name.localeCompare(b.name)
      );
  },

  async getById(id: string): Promise<ExpectedPackage | null> {
    const db = await getDb();
    const rows = await db.select().from(envRegistry).where(eq(envRegistry.id, id)).limit(1);
    return rows[0] ? toExpected(rows[0]) : null;
  },

  /**
   * 仅供 user 在 UI 添加：is_builtin=false, source=user。
   * 同 (kind, package_name) 已存在 → throw duplicate。
   */
  async createUserItem(input: CreateUserItemInput): Promise<ExpectedPackage> {
    if (input.kind !== "python" && input.kind !== "npm") {
      throw new EnvRegistryError("invalid_kind");
    }
    if (!input.packageName.trim() || !input.displayName.trim()) {
      throw new EnvRegistryError("invalid_field");
    }
    const db = await getDb();
    const dup = await db
      .select()
      .from(envRegistry)
      .where(
        and(eq(envRegistry.kind, input.kind), eq(envRegistry.packageName, input.packageName))
      )
      .limit(1);
    if (dup[0]) throw new EnvRegistryError("duplicate");

    const id = randomUUID();
    await db.insert(envRegistry).values({
      id,
      kind: input.kind,
      packageName: input.packageName,
      displayName: input.displayName,
      description: input.description ?? "",
      versionSpec: null,
      userVersionSpec: input.versionSpec ?? null,
      optional: input.optional ?? true,
      capability: input.capability ?? "user/misc",
      source: "user",
      status: "enabled",
      isBuiltin: false,
      extraJson: {},
    });

    const got = await this.getById(id);
    if (!got) throw new EnvRegistryError("not_found");
    return got;
  },

  /**
   * 系统项（is_builtin=true）只允许改 status / userVersionSpec；其余字段
   * 写入会被静默忽略（避免 seed 与用户编辑互相覆盖）。
   * 用户项（is_builtin=false）可改全部字段。
   */
  async update(id: string, patch: UpdateRegistryInput): Promise<ExpectedPackage> {
    const existing = await this.getById(id);
    if (!existing) throw new EnvRegistryError("not_found");

    const update: Partial<EnvRegistryRow> = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.userVersionSpec !== undefined)
      update.userVersionSpec = patch.userVersionSpec;

    if (!existing.isBuiltin) {
      if (patch.displayName !== undefined) update.displayName = patch.displayName;
      if (patch.description !== undefined) update.description = patch.description;
      if (patch.optional !== undefined) update.optional = patch.optional;
      if (patch.capability !== undefined) update.capability = patch.capability;
    }

    const db = await getDb();
    await db.update(envRegistry).set(update).where(eq(envRegistry.id, id));
    const got = await this.getById(id);
    if (!got) throw new EnvRegistryError("not_found");
    return got;
  },

  async remove(id: string): Promise<void> {
    const existing = await this.getById(id);
    if (!existing) throw new EnvRegistryError("not_found");
    if (existing.isBuiltin) throw new EnvRegistryError("builtin_protected");
    const db = await getDb();
    await db.delete(envRegistry).where(eq(envRegistry.id, id));
  },
};
