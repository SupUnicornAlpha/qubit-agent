/**
 * Self-Evolving Agent P9 — reason 节点 PnL-aware skill prompt 块。
 *
 * 在 reason 节点的现有 skill recall 旁边，额外注入"该 agent 最近 N 天最赚钱 top-K skill"
 * 引导 LLM 在选下一步时偏向有 PnL 证据的 skill（不是只看语义相关）。
 *
 * 设计：
 *   - 纯函数 + DB 显式注入（不写 IO，只查 SkillAttributor），便于单测；
 *   - 失败完全降级返回空串（reason 主链路绝不阻塞）；
 *   - 总闸 + pnlAwareReasonEnabled 关时返回空串（worker / 路由层不另做 short-circuit）；
 *   - 排序 pnlSum desc；只输出 pnlSum > 0 的 skill（无收益的不引导 LLM 用）。
 */

import type { DbClient } from "../../../db/sqlite/client";
import { getSelfEvolveConfig } from "../../config/self-evolve-config";
import { createSkillAttributor } from "../../attribution/skill-attributor";

export interface PnlAwareSkillEntry {
  skillId: string;
  name: string;
  pnlSum: number;
  winCount: number;
  loseCount: number;
  sampleCount: number;
}

/**
 * 给一个 agent definition，返回最近窗口期最赚钱的 top-N skill。
 * 关掉 / 没有数据时返回 []。
 */
export async function fetchPnlAwareTopSkills(
  db: DbClient,
  definitionId: string
): Promise<PnlAwareSkillEntry[]> {
  const cfg = getSelfEvolveConfig();
  if (!cfg.enabled || !cfg.pnlAwareReasonEnabled) return [];
  try {
    const attr = createSkillAttributor(db);
    const rows = await attr.listSkillRankingsByDefinition(definitionId, {
      windowDays: cfg.reasonPnlWindowDays,
      topK: cfg.reasonPnlTopN,
      minSampleCount: 1,
    });
    return rows.filter((r) => r.pnlSum > 0);
  } catch {
    return [];
  }
}

/**
 * 渲染成 prompt block。empty 返回空串，便于 caller 直接 `${block}` 嵌入。
 */
export function renderPnlAwareSkillBlock(rows: PnlAwareSkillEntry[]): string {
  if (rows.length === 0) return "";
  const cfg = getSelfEvolveConfig();
  const lines: string[] = [];
  lines.push(`**该 Agent 最近 ${cfg.reasonPnlWindowDays} 天最赚钱 top-${rows.length} skill**：`);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    const winRate = r.sampleCount > 0 ? (r.winCount / r.sampleCount) * 100 : 0;
    lines.push(
      `${i + 1}. **${r.name}** — pnl=+${r.pnlSum.toFixed(2)}（${r.winCount}胜/${r.loseCount}负/共${r.sampleCount}次，胜率 ${winRate.toFixed(0)}%）`
    );
  }
  lines.push(
    "_提示：若本步任务与上面任一 skill 相关，请优先复用并在 reasonText 里引用其 id；这不是命令，仅基于过去的实盘 PnL。_"
  );
  return lines.join("\n");
}

/** 一站式：拉 + 渲染。reason 节点直接调它，省一行 boilerplate。 */
export async function buildPnlAwareSkillBlock(
  db: DbClient,
  definitionId: string
): Promise<string> {
  const rows = await fetchPnlAwareTopSkills(db, definitionId);
  return renderPnlAwareSkillBlock(rows);
}
