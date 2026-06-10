/**
 * Wave-1（2026-06-10）：Skill 自动执行反馈钩子。
 *
 * 解决的问题：
 *   reason 节点每次跑 `skillService.searchWithMeta` 会写一批 `skill_recall_log`
 *   (executed=false)；只有在 LLM 主动调 `skill.use_record(skillId)` 时 recordUsage
 *   才会把日志翻 executed=true。
 *
 *   实测（2026-06-09 smoke）：3 个 workflow 召回 45 次 / 执行 0 次 ——
 *   LLM 看到 prompt 里的 skill 介绍后会自然"按 skill 步骤执行 tool"，但根本
 *   不会主动调一次 `skill.use_record`。"执行率 = 0%" 不是说没有真执行，是说
 *   全靠 LLM 自报，链路根本不通。
 *
 * 本钩子的策略：
 *   1. act 节点 tool call 成功后立刻调用本函数（fire-and-forget，不阻塞 graph）。
 *   2. 找该 workflowRunId 下所有 executed=false 的 skill_recall_log。
 *   3. join 出 skill name/description/bodyMd，做简单字符串匹配：toolName / mcpServerName
 *      / connectorName 等关键 token 命中 → 视作"该召回 skill 被采纳执行"。
 *   4. 命中即调 `skillService.recordUsage`，自动翻 executed=true + 写 agent_skill_run +
 *      累计 useCount/successCount。
 *
 * 误报控制：
 *   - 匹配是子串包含，对于通用名（如 "tool"、"data"）会命中所有 skill；这里只
 *     接受 ≥ 4 个字符的 token。
 *   - 失败仅 warn，不抛错。
 *   - 单次 act 节点最多扫几十条召回行，DB 开销可接受。
 *
 * 后续 Wave-2 计划：
 *   把"skill ↔ recommended tool/connector list" 显式声明在 skill metadata 里，
 *   不再靠子串匹配。
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { agentSkill, skillRecallLog } from "../../db/sqlite/schema";
import type { AgentSkillOutcome } from "../../types/entities";
import { skillService } from "./skill-service";

export interface AutoMarkInput {
  workflowRunId: string;
  /** tool 全名：builtin (factor.register) / connector (qubit-data/fetch_klines) / mcp (publicfinance.treasury_rates) */
  toolName: string;
  /** 若是 MCP，server 名（如 "publicfinance"），帮助匹配 skill 提到的 server */
  mcpServerName?: string | null;
  definitionId?: string | null;
  /** 该 tool call 是否成功；默认 success */
  outcome?: AgentSkillOutcome;
}

export interface AutoMarkResult {
  /** 候选召回行数 */
  scanned: number;
  /** 命中的 skill id 列表（去重） */
  matched: string[];
  /** 成功翻 executed=true 并写 agent_skill_run 的条数 */
  recorded: number;
}

/** body 太长会拖慢字符串匹配；限制看前 8KB 已覆盖所有 step-by-step skill */
const MAX_BODY_LOOKUP_BYTES = 8 * 1024;

/** ≥ 4 个字符的 token 才参与匹配，避免 "tool"/"data" 等通用词全命中 */
const MIN_TOKEN_LENGTH = 4;

/**
 * 把 tool 全名拆出可匹配的 token：
 *   - 全名本身（"publicfinance.treasury_rates"）
 *   - 用 "." / "/" 切出的子段（"publicfinance", "treasury_rates"）
 *   - 显式传入的 mcpServerName
 *
 * 长度 < 4 的 token 被过滤掉。
 */
export function buildSearchTokens(toolName: string, mcpServerName?: string | null): string[] {
  const tokens = new Set<string>();
  const add = (t: string) => {
    const trimmed = t.trim();
    if (trimmed.length >= MIN_TOKEN_LENGTH) tokens.add(trimmed.toLowerCase());
  };
  if (toolName) {
    add(toolName);
    for (const part of toolName.split(/[./]/)) add(part);
  }
  if (mcpServerName) add(mcpServerName);
  return [...tokens];
}

export async function autoMarkRecalledSkillsAsExecuted(
  input: AutoMarkInput
): Promise<AutoMarkResult> {
  const result: AutoMarkResult = { scanned: 0, matched: [], recorded: 0 };
  const tokens = buildSearchTokens(input.toolName, input.mcpServerName);
  if (tokens.length === 0) return result;

  try {
    const db = await getDb();
    const pendings = await db
      .select({ skillId: skillRecallLog.skillId })
      .from(skillRecallLog)
      .where(
        and(
          eq(skillRecallLog.workflowRunId, input.workflowRunId),
          eq(skillRecallLog.executed, false)
        )
      );
    if (pendings.length === 0) return result;
    result.scanned = pendings.length;

    const skillIds = [...new Set(pendings.map((p) => p.skillId))];
    if (skillIds.length === 0) return result;

    const skills = await db
      .select({
        id: agentSkill.id,
        name: agentSkill.name,
        description: agentSkill.description,
        bodyMd: agentSkill.bodyMd,
        projectId: agentSkill.projectId,
        definitionId: agentSkill.definitionId,
      })
      .from(agentSkill)
      .where(inArray(agentSkill.id, skillIds));

    for (const skill of skills) {
      const body = (skill.bodyMd ?? "").slice(0, MAX_BODY_LOOKUP_BYTES);
      const haystack = `${skill.name} ${skill.description ?? ""} ${body}`.toLowerCase();
      const hit = tokens.some((t) => haystack.includes(t));
      if (!hit) continue;
      result.matched.push(skill.id);

      try {
        await skillService.recordUsage({
          skillId: skill.id,
          projectId: skill.projectId,
          workflowRunId: input.workflowRunId,
          definitionId: input.definitionId ?? skill.definitionId ?? null,
          outcome: input.outcome ?? "success",
          notes:
            `auto-hook: tool=${input.toolName}` +
            (input.mcpServerName ? ` server=${input.mcpServerName}` : ""),
        });
        result.recorded += 1;
      } catch (err) {
        console.warn(
          `[auto-skill-exec-hook] recordUsage failed for skill=${skill.id} ` +
            `wf=${input.workflowRunId}: ${(err as Error).message}`
        );
      }
    }
    return result;
  } catch (err) {
    console.warn(`[auto-skill-exec-hook] scan failed wf=${input.workflowRunId}: ${(err as Error).message}`);
    return result;
  }
}
