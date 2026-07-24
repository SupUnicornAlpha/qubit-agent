import type { AgentRole } from "../../types/entities";
import { isFsiActive, resolveEnabledFsiBundles } from "./fsi-config";
import {
  getFsiWorkflowPlaybookPathsForRole,
  resolveActiveFsiSkillIdsForRole,
} from "./fsi-manifest-loader";
import { assembleFsiSkillsBlock, resolveFsiPlaybookBody } from "./fsi-skill-resolver";

const SKILL_ALIASES: Record<string, string[]> = {
  earnings: ["财报", "业绩", "盈利", "营收", "利润", "earnings"],
  preview: ["预览", "预期", "一致预期", "preview"],
  sector: ["行业", "板块", "赛道", "sector", "industry"],
  coverage: ["覆盖", "深度研究", "公司研究", "coverage"],
  model: ["模型", "建模", "估值", "model"],
  morning: ["晨报", "早报", "morning"],
  thesis: ["投资逻辑", "论点", "跟踪", "thesis"],
  idea: ["选股", "推荐", "机会", "筛选", "idea"],
  comps: ["可比", "同业", "对标", "comps"],
  dcf: ["dcf", "现金流折现", "估值"],
  audit: ["审计", "核验", "audit"],
  xlsx: ["表格", "excel", "xlsx"],
  competitive: ["竞争", "竞品", "护城河", "competitive"],
};

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function relevanceScore(id: string, query: string): number {
  const normalizedId = id.toLowerCase();
  let score = 0;
  if (query && (normalizedId.includes(query) || query.includes(normalizedId))) score += 8;
  for (const part of normalizedId.split(/[\/\-_\s]+/).filter(Boolean)) {
    if (query.includes(part)) score += 3;
    for (const alias of SKILL_ALIASES[part] ?? []) {
      if (query.includes(alias)) score += 2;
    }
  }
  return score;
}

export function selectRelevantFsiSkillIds(
  skillIds: string[],
  queryText: string,
  maxSkills = 2
): string[] {
  const unique = [...new Set(skillIds)];
  const query = normalizeQuery(queryText);
  if (!query) return unique.slice(0, Math.max(0, maxSkills));
  const ranked = unique
    .map((id, index) => ({ id, index, score: relevanceScore(id, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const matched = ranked.filter((item) => item.score > 0);
  return (matched.length > 0 ? matched : ranked).slice(0, Math.max(0, maxSkills)).map((x) => x.id);
}

/**
 * 在既有 system prompt 后追加 FSI 技能与工作流 playbook（不修改 DB 主提示）。
 * 无 content root 时仅追加简短说明，不抛错。
 */
export async function enrichSystemPromptWithFsi(params: {
  role: AgentRole;
  basePrompt: string;
  /** agent_definition.skillsJson 中已声明的 skill id（含内置与 fsi/） */
  declaredSkillIds?: string[];
  /** 用于动态选择技能与 playbook，避免按角色全量注入。 */
  queryText?: string;
  maxSkills?: number;
  maxSkillChars?: number;
  maxPlaybooks?: number;
  maxPlaybookChars?: number;
}): Promise<string> {
  if (!isFsiActive()) return params.basePrompt;

  const bundleIds = resolveEnabledFsiBundles();
  const activeFromConfig = await resolveActiveFsiSkillIdsForRole(params.role);
  const declared = (params.declaredSkillIds ?? []).filter((id) => id.startsWith("fsi/"));
  const skillIds = selectRelevantFsiSkillIds(
    [...new Set([...activeFromConfig, ...declared])],
    params.queryText ?? "",
    params.maxSkills ?? 2
  );

  const blocks: string[] = [params.basePrompt];

  if (bundleIds.length > 0) {
    blocks.push(
      `\n\n---\n【FSI 内容包】已启用 bundle：${bundleIds.join(", ")}。遵循技能中的 MCP 优先与引用规范；无 MCP 时使用平台 connector。`
    );
  }

  if (skillIds.length > 0) {
    const skillsBlock = await assembleFsiSkillsBlock(skillIds, {
      maxTotalChars: params.maxSkillChars ?? 6000,
    });
    if (skillsBlock.trim()) blocks.push(`\n\n---\n${skillsBlock}`);
  }

  const playbooks = await getFsiWorkflowPlaybookPathsForRole(params.role);
  const query = normalizeQuery(params.queryText ?? "");
  const rankedPlaybooks = playbooks
    .map((playbook, index) => ({
      playbook,
      index,
      score: relevanceScore(playbook.searchText, query),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const matchedPlaybooks = rankedPlaybooks.filter((item) => item.score > 0);
  const selectedPlaybooks = (matchedPlaybooks.length > 0 ? matchedPlaybooks : rankedPlaybooks).slice(
    0,
    params.maxPlaybooks ?? 1
  );
  let playbookBudget = params.maxPlaybookChars ?? 2500;
  for (const { playbook: pb } of selectedPlaybooks) {
    if (playbookBudget <= 0) break;
    const maxChars = Math.min(pb.maxChars, playbookBudget);
    const body = await resolveFsiPlaybookBody(pb.path, maxChars);
    if (!body) continue;
    playbookBudget -= body.length;
    blocks.push(
      `\n\n---\n## FSI 工作流：${pb.slug}\n${body}`
    );
  }

  return blocks.join("");
}

/** 合并 seed/DB 技能列表：在 FSI 启用时追加 fsi/* skill id（去重） */
export async function mergeFsiSkillsForRole(
  role: AgentRole,
  existingSkills: string[]
): Promise<string[]> {
  if (!isFsiActive()) return existingSkills;
  const extra = await resolveActiveFsiSkillIdsForRole(role);
  return [...new Set([...existingSkills, ...extra])];
}
