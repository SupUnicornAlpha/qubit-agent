/**
 * Skill 来源三分法（配置中心展示）：
 *   - network：市场 / GitHub / Open Skill Market 下载
 *   - authored：官方预制 + 个人手写
 *   - agent：curator 归纳 / evolver 演化
 */
import type { AgentSkillRecord } from "../../api/types";
import type { ResourceOrigin } from "../common/OriginBadge";

export type SkillOriginBucket = "network" | "authored" | "agent";

export type SkillOriginKind =
  | "network"
  | "official"
  | "personal"
  | "agent_induced"
  | "agent_evolved";

const OFFICIAL_CREATED_BY = new Set([
  "builtin-quant-sync",
  "builtin-fsi-sync",
  "seed",
  "system",
]);

function metaRecord(skill: AgentSkillRecord): Record<string, unknown> {
  const raw = skill.metadataJson;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

export function classifySkillOrigin(skill: AgentSkillRecord): SkillOriginKind {
  if (skill.source === "open_skill_market") return "network";
  if (skill.source === "evolved") return "agent_evolved";
  if (skill.source === "agent_created") return "agent_induced";

  const meta = metaRecord(skill);
  const syncedFrom = typeof meta.syncedFrom === "string" ? meta.syncedFrom : "";
  const officialFlag = meta.official === true || meta.originKind === "official";
  if (
    officialFlag ||
    OFFICIAL_CREATED_BY.has(skill.createdBy) ||
    syncedFrom.startsWith("seed-") ||
    skill.name.startsWith("quant:") ||
    skill.name.startsWith("fsi:")
  ) {
    return "official";
  }
  return "personal";
}

export function skillOriginBucket(kind: SkillOriginKind): SkillOriginBucket {
  if (kind === "network") return "network";
  if (kind === "agent_induced" || kind === "agent_evolved") return "agent";
  return "authored";
}

export const SKILL_ORIGIN_KIND_LABEL: Record<SkillOriginKind, string> = {
  network: "网络下载",
  official: "官方预制",
  personal: "个人编写",
  agent_induced: "Agent 归纳",
  agent_evolved: "Agent 演化",
};

export const SKILL_ORIGIN_BUCKET_LABEL: Record<SkillOriginBucket, string> = {
  network: "网络下载",
  authored: "官方 / 个人编写",
  agent: "Agent 归纳",
};

/** Map to OriginBadge origin keys (extended labels in OriginBadge). */
export function skillOriginBadgeKey(kind: SkillOriginKind): ResourceOrigin | string {
  switch (kind) {
    case "network":
      return "open_skill_market";
    case "official":
      return "builtin";
    case "personal":
      return "user_authored";
    case "agent_induced":
      return "agent_created";
    case "agent_evolved":
      return "evolved";
  }
}
