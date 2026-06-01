/**
 * env_install_log 查询服务 —— 给路由层 / 前端短轮询用。
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { envInstallLog } from "../../db/sqlite/schema";
import type { EnvKind } from "./types";

export type EnvInstallLogStatus = "running" | "success" | "failed" | "timeout";
export type EnvInstallOperation = "install" | "uninstall" | "upgrade";

export interface EnvInstallLogEntry {
  id: string;
  kind: EnvKind;
  operation: EnvInstallOperation;
  packageName: string;
  requestedVersion: string | null;
  installedVersion: string | null;
  status: EnvInstallLogStatus;
  errorMessage: string | null;
  startedAt: string;
  finishedAt: string | null;
  triggeredBy: string;
}

export interface ListInstallLogFilter {
  kind?: EnvKind;
  packageName?: string;
  status?: EnvInstallLogStatus;
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const envInstallLogService = {
  async list(filter: ListInstallLogFilter = {}): Promise<EnvInstallLogEntry[]> {
    const db = await getDb();
    const conditions = [];
    if (filter.kind) conditions.push(eq(envInstallLog.kind, filter.kind));
    if (filter.packageName)
      conditions.push(eq(envInstallLog.packageName, filter.packageName));
    if (filter.status) conditions.push(eq(envInstallLog.status, filter.status));
    const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

    const rows = await (conditions.length
      ? db
          .select()
          .from(envInstallLog)
          .where(and(...conditions))
          .orderBy(desc(envInstallLog.startedAt))
          .limit(limit)
      : db
          .select()
          .from(envInstallLog)
          .orderBy(desc(envInstallLog.startedAt))
          .limit(limit));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as EnvKind,
      operation: r.operation as EnvInstallOperation,
      packageName: r.packageName,
      requestedVersion: r.requestedVersion ?? null,
      installedVersion: r.installedVersion ?? null,
      status: r.status as EnvInstallLogStatus,
      errorMessage: r.errorMessage ?? null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
      triggeredBy: r.triggeredBy,
    }));
  },

  async getById(id: string): Promise<EnvInstallLogEntry | null> {
    const list = await this.list();
    return list.find((it) => it.id === id) ?? null;
  },
};
