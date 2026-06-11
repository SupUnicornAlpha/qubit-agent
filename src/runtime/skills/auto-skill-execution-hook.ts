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
 *   3. 判定流程（W2 改造，2026-06-11）：
 *        a. 优先看 skill.recommended_tools_json：toolName 精确出现或前缀命中 → 标 executed
 *           （高置信度，无误报）。
 *        b. 该列表为空时退回旧的子串匹配：toolName / mcpServerName 中 ≥4 字的 token
 *           被 skill 的 name/description/bodyMd 包含 → 标 executed（兼容存量 skill）。
 *   4. 命中即调 `skillService.recordUsage`，自动翻 executed=true + 写 agent_skill_run +
 *      累计 useCount/successCount。
 *
 * 误报控制：
 *   - W2 路径不做模糊匹配（精确 / 前缀），完全无误报。
 *   - Fallback 子串匹配只接受 ≥ 4 字符 token，避免 "tool"/"data" 全命中。
 *   - 失败仅 warn，不抛错。
 *   - 单次 act 节点最多扫几十条召回行，DB 开销可接受。
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
 * W2：判断 toolName / mcpServerName 是否落在 skill 显式声明的 recommended_tools 白名单。
 *
 * 命中规则（按优先级）：
 *   1. 完全相等（case-insensitive）：`recommended === toolName`
 *   2. 同 namespace 前缀：`recommended === "${namespace}.*"` 时 toolName 以 `${namespace}.`
 *      开头视为命中（让单条声明覆盖一族工具，避免 skill metadata 维护负担）。
 *   3. mcp server 维度：`recommended` 形如 `"mcp:<server>"` 时，传入 `mcpServerName === server`
 *      视为命中（skill 表述"用 publicfinance MCP"但具体调哪个工具不写死）。
 */
export function matchRecommendedTool(
  recommendedTools: string[],
  toolName: string,
  mcpServerName?: string | null
): boolean {
  if (!recommendedTools.length) return false;
  const tn = toolName.trim().toLowerCase();
  const mcp = (mcpServerName ?? "").trim().toLowerCase();
  for (const rawRec of recommendedTools) {
    const rec = rawRec.trim().toLowerCase();
    if (!rec) continue;
    if (rec === tn) return true;
    if (rec.endsWith(".*")) {
      const ns = rec.slice(0, -2);
      if (ns && (tn === ns || tn.startsWith(`${ns}.`))) return true;
    }
    if (mcp && rec === `mcp:${mcp}`) return true;
  }
  return false;
}

/** 安全解析 recommendedToolsJson；任何异常都退回空数组（让 hook 走 fallback 路径）。 */
export function parseRecommendedToolsJson(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

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
        recommendedToolsJson: agentSkill.recommendedToolsJson,
      })
      .from(agentSkill)
      .where(inArray(agentSkill.id, skillIds));

    for (const skill of skills) {
      const recommended = parseRecommendedToolsJson(skill.recommendedToolsJson);
      let hit = false;
      let matchSource: "recommended" | "fallback_substring" = "fallback_substring";
      if (recommended.length > 0) {
        if (matchRecommendedTool(recommended, input.toolName, input.mcpServerName)) {
          hit = true;
          matchSource = "recommended";
        }
        /**
         * 显式列出 recommended 但不命中 → 不走 fallback。
         * 设计理由：作者既然写了白名单，就应该完整列出。fallback 只服务"还没写白名单"的存量 skill。
         */
      } else {
        const body = (skill.bodyMd ?? "").slice(0, MAX_BODY_LOOKUP_BYTES);
        const haystack = `${skill.name} ${skill.description ?? ""} ${body}`.toLowerCase();
        hit = tokens.some((t) => haystack.includes(t));
      }
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
            `auto-hook[${matchSource}]: tool=${input.toolName}` +
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
