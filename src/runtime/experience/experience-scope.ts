/**
 * Unified Experience write scope — prefer FS workspace when bound.
 */

import type { ExperienceScope } from "../../types/entities";

export interface ExperienceWriteScopeInput {
  projectId: string;
  fsWorkspaceId?: string | null;
}

export function resolveExperienceWriteScope(input: ExperienceWriteScopeInput): {
  scope: ExperienceScope;
  scopeId: string;
} {
  const ws = input.fsWorkspaceId?.trim();
  if (ws && !ws.startsWith("wf_")) {
    return { scope: "workspace", scopeId: ws };
  }
  return { scope: "project", scopeId: input.projectId };
}

export function defaultVisibilityForWriteScope(scope: ExperienceScope): "workspace_shared" | "project_shared" {
  return scope === "workspace" ? "workspace_shared" : "project_shared";
}
