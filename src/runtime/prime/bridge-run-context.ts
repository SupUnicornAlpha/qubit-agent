/**
 * Correlate Core → Bun legacy.tools.invoke with the active workflow stream.
 * Desktop is typically single-turn; last-writer-wins is enough for UI projection.
 */

export type PrimeBridgeRunContext = {
  workflowId: string;
  runId: string;
  traceId: string;
  role?: string;
  sessionId?: string;
};

let active: PrimeBridgeRunContext | null = null;

export function setPrimeBridgeRunContext(ctx: PrimeBridgeRunContext): void {
  active = ctx;
}

export function clearPrimeBridgeRunContext(
  match?: Partial<Pick<PrimeBridgeRunContext, "workflowId" | "runId">>
): void {
  if (!active) return;
  if (match?.workflowId && active.workflowId !== match.workflowId) return;
  if (match?.runId && active.runId !== match.runId) return;
  active = null;
}

export function getPrimeBridgeRunContext(): PrimeBridgeRunContext | null {
  return active;
}

/** Parse `wf_<workflowId>` from Core session workspace_id. */
export function workflowIdFromCoreWorkspace(workspaceId: string | undefined | null): string | null {
  if (!workspaceId || typeof workspaceId !== "string") return null;
  if (workspaceId.startsWith("wf_")) {
    const id = workspaceId.slice(3).trim();
    return id || null;
  }
  return null;
}
