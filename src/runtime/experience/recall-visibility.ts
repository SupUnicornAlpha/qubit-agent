/**
 * Experience recall visibility routing (Memory V2 dimension补齐).
 *
 * Store.query 不按 visibility 过滤 —— Recall 层在 scope 池收集后做访问控制。
 */

import type { Experience, ExperienceVisibility } from "../../types/entities";

export type RecallScopeTarget = { scope: "workspace" | "project"; scopeId: string };

export interface RecallVisibilityContext {
  definitionId: string | null;
  role?: string;
  scopeTarget: RecallScopeTarget;
}

const SHARED_VISIBILITIES: ExperienceVisibility[] = [
  "project_shared",
  "workspace_shared",
  "role_shared",
];

/** Vector / keyword 共享池：按 scope 目标决定拉哪些 visibility 桶。 */
export function sharedVisibilitiesForScopeTarget(
  target: RecallScopeTarget
): ExperienceVisibility[] {
  if (target.scope === "workspace") {
    return ["project_shared", "workspace_shared", "role_shared"];
  }
  return ["project_shared", "role_shared"];
}

export function experienceRoleTags(exp: Experience): string[] {
  const fromTags = exp.tagsJson
    .filter((t) => t.startsWith("role:"))
    .map((t) => t.slice("role:".length).toLowerCase());
  const metaRole = exp.metadataJson?.role;
  if (typeof metaRole === "string" && metaRole.trim()) {
    fromTags.push(metaRole.trim().toLowerCase());
  }
  return fromTags;
}

export function isExperienceVisibleToCaller(
  exp: Experience,
  ctx: RecallVisibilityContext
): boolean {
  switch (exp.visibility) {
    case "project_shared":
      return true;
    case "workspace_shared":
      return ctx.scopeTarget.scope === "workspace";
    case "role_shared": {
      const callerRole = ctx.role?.trim().toLowerCase();
      if (!callerRole) return false;
      return experienceRoleTags(exp).includes(callerRole);
    }
    case "agent_private":
      return Boolean(ctx.definitionId && exp.definitionId === ctx.definitionId);
    default:
      return false;
  }
}

export function filterVisibleExperiences(
  experiences: Experience[],
  ctx: Omit<RecallVisibilityContext, "scopeTarget"> & { scopeTarget?: RecallScopeTarget }
): Experience[] {
  return experiences.filter((exp) => {
    const target: RecallScopeTarget =
      ctx.scopeTarget ??
      (exp.scope === "workspace"
        ? { scope: "workspace", scopeId: exp.scopeId }
        : { scope: "project", scopeId: exp.scopeId });
    return isExperienceVisibleToCaller(exp, { ...ctx, scopeTarget: target });
  });
}

export function filterVisibleForScopeTarget(
  experiences: Experience[],
  ctx: RecallVisibilityContext
): Experience[] {
  return experiences.filter((exp) => isExperienceVisibleToCaller(exp, ctx));
}

/** 共享 kind 召回后按 visibility 二次过滤（reflective 走 definitionId 专用路径）。 */
export function filterSharedPool(
  pool: Experience[],
  ctx: RecallVisibilityContext
): Experience[] {
  return pool.filter((exp) => {
    if (!SHARED_VISIBILITIES.includes(exp.visibility) && exp.visibility !== "agent_private") {
      return false;
    }
    if (exp.visibility === "agent_private") {
      return Boolean(ctx.definitionId && exp.definitionId === ctx.definitionId);
    }
    return isExperienceVisibleToCaller(exp, ctx);
  });
}
