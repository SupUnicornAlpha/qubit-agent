import type { AgentRole } from "../../types/entities";
import { isFsiActive, resolveEnabledFsiBundles } from "./fsi-config";
import {
  getFsiWorkflowPlaybookPathsForRole,
  resolveActiveFsiSkillIdsForRole,
} from "./fsi-manifest-loader";
import { assembleFsiSkillsBlock, resolveFsiPlaybookBody } from "./fsi-skill-resolver";

/**
 * 在既有 system prompt 后追加 FSI 技能与工作流 playbook（不修改 DB 主提示）。
 * 无 content root 时仅追加简短说明，不抛错。
 */
export async function enrichSystemPromptWithFsi(params: {
  role: AgentRole;
  basePrompt: string;
  /** agent_definition.skillsJson 中已声明的 skill id（含内置与 fsi/） */
  declaredSkillIds?: string[];
}): Promise<string> {
  if (!isFsiActive()) return params.basePrompt;

  const bundleIds = resolveEnabledFsiBundles();
  const activeFromConfig = await resolveActiveFsiSkillIdsForRole(params.role);
  const declared = (params.declaredSkillIds ?? []).filter((id) => id.startsWith("fsi/"));
  const skillIds = [...new Set([...activeFromConfig, ...declared])];

  const blocks: string[] = [params.basePrompt];

  if (bundleIds.length > 0) {
    blocks.push(
      `\n\n---\n【FSI 内容包】已启用 bundle：${bundleIds.join(", ")}。遵循技能中的 MCP 优先与引用规范；无 MCP 时使用平台 connector。`
    );
  }

  if (skillIds.length > 0) {
    const skillsBlock = await assembleFsiSkillsBlock(skillIds);
    if (skillsBlock.trim()) blocks.push(`\n\n---\n${skillsBlock}`);
  }

  const playbooks = await getFsiWorkflowPlaybookPathsForRole(params.role);
  for (const pb of playbooks) {
    const body = await resolveFsiPlaybookBody(pb.path, pb.maxChars);
    if (!body) continue;
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
