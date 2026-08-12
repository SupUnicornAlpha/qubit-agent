/**
 * Resolve FS Workspace id (课题目录) — 非 Core `wf_*` session workspace。
 * 优先级：显式参数 → workflow.loopOptionsJson → env QUBIT_ACTIVE_FS_WORKSPACE_ID。
 */
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { workflowRun } from "../../db/sqlite/schema";
import { parseLoopOptionsJson } from "../../types/loop";

export function isFsWorkspaceId(raw: string | null | undefined): raw is string {
  const id = raw?.trim() ?? "";
  return Boolean(id) && !id.startsWith("wf_");
}

/** Params from bridge tools / HTTP (camel + snake). */
export function resolveFsWorkspaceIdFromParams(params: Record<string, unknown>): string | null {
  const direct =
    (typeof params.fs_workspace_id === "string" && params.fs_workspace_id.trim()) ||
    (typeof params.fsWorkspaceId === "string" && params.fsWorkspaceId.trim()) ||
    "";
  if (isFsWorkspaceId(direct)) return direct.trim();

  const raw =
    (typeof params.workspace_id === "string" && params.workspace_id.trim()) ||
    (typeof params.workspaceId === "string" && params.workspaceId.trim()) ||
    "";
  return isFsWorkspaceId(raw) ? raw.trim() : null;
}

export function resolveFsWorkspaceIdFromLoopOptions(raw: unknown): string | null {
  const opts = parseLoopOptionsJson(raw);
  return isFsWorkspaceId(opts.fsWorkspaceId) ? opts.fsWorkspaceId.trim() : null;
}

export function resolveFsWorkspaceIdFromEnv(): string | null {
  const env = process.env.QUBIT_ACTIVE_FS_WORKSPACE_ID?.trim() ?? "";
  return isFsWorkspaceId(env) ? env : null;
}

/** Full resolution for bridge / reason / pipes. */
export async function resolveActiveFsWorkspaceId(opts?: {
  params?: Record<string, unknown>;
  workflowId?: string | null;
  loopOptionsJson?: unknown;
}): Promise<string | null> {
  if (opts?.params) {
    const fromParams = resolveFsWorkspaceIdFromParams(opts.params);
    if (fromParams) return fromParams;
  }
  if (opts?.loopOptionsJson !== undefined) {
    const fromLoop = resolveFsWorkspaceIdFromLoopOptions(opts.loopOptionsJson);
    if (fromLoop) return fromLoop;
  }
  if (opts?.workflowId?.trim()) {
    try {
      const db = await getDb();
      const row = (
        await db
          .select({ loopOptionsJson: workflowRun.loopOptionsJson })
          .from(workflowRun)
          .where(eq(workflowRun.id, opts.workflowId.trim()))
          .limit(1)
      )[0];
      const fromWf = resolveFsWorkspaceIdFromLoopOptions(row?.loopOptionsJson);
      if (fromWf) return fromWf;
    } catch {
      // Missing workflow must not block recall.
    }
  }
  return resolveFsWorkspaceIdFromEnv();
}
