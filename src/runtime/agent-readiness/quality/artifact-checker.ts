/**
 * P2 优先级 · artifact gate（Round 7 复盘 2026-06-08）
 *
 * 给 React loop 用：在 LLM 输出 `{"tool":"none"}` 准备 stop 时，先按 scenario
 * expectations 反查"必备 artifact 是否落库"。没满足就阻止停机、把 hint 塞回
 * observation，让 graph 自然回 reason → 再调一次工具。
 *
 * 这是 evaluator 跑完才打分的 A-1 指标的 *先验闸*：评测里 A-1=0 = LLM 该调
 * strategy.create_version / order.create_intent 但没调，最常见的原因是 LLM 主
 * 动给了 markdown 总结就 tool=none。此闸让"必备工具未调 → 强制再跑"成为 graph
 * 行为，而不只是事后扣分。
 *
 * 与 quality/content-quality.ts 的 evaluateArtifact 共享 countSql 写法（一份
 * scenario-expectations 数据，两个 caller 复用）。
 */

import type { Database } from "bun:sqlite";
import {
  getScenarioExpectation,
  SCENARIO_EXPECTATIONS,
} from "./scenario-expectations";
import type { ScenarioRecipe } from "../scenarios";

export interface ArtifactGapDetail {
  table: string;
  rows: number;
  minRows: number;
}

export interface ArtifactCheckResult {
  scenario: ScenarioRecipe["key"];
  ok: boolean;
  /** 不满足 minRows 的产物列表 */
  missing: ArtifactGapDetail[];
  /** 所有产物当前 rows（含已满足）；便于日志与 reason 节点回填 prompt */
  rows: ArtifactGapDetail[];
}

/**
 * 反查 workflow_run 对应的 scenario_id（runner 在 tagWorkflowWithScenario 写入）。
 *
 * @returns scenario key（已知场景） / null（未 tag 或未知值，act 节点应该 fallback no-op）
 */
export function resolveScenarioKey(
  sqlite: Database,
  workflowRunId: string
): ScenarioRecipe["key"] | null {
  try {
    const row = sqlite
      .prepare("SELECT research_scenario_id AS s FROM workflow_run WHERE id = ?")
      .get(workflowRunId) as { s?: string | null } | undefined;
    const raw = (row?.s ?? "").trim();
    if (!raw) return null;
    if (raw in SCENARIO_EXPECTATIONS) {
      return raw as ScenarioRecipe["key"];
    }
    return null;
  } catch {
    /** column 缺失或表不存在 → 旧 DB，fallback no-op */
    return null;
  }
}

/**
 * 按 scenario 的 requiredArtifacts 反查产物落库情况。
 *
 * countSql 的第一个 `?` 占位符 = workflowRunId（与 evaluateArtifact 完全一致）。
 * 不抛错：单条 SQL 失败时该 artifact 计 0 rows，避免一条坏 SQL 阻塞整个 gate。
 */
export function checkRequiredArtifacts(
  sqlite: Database,
  scenario: ScenarioRecipe["key"],
  workflowRunId: string
): ArtifactCheckResult {
  const exp = getScenarioExpectation(scenario);
  const rows: ArtifactGapDetail[] = [];
  const missing: ArtifactGapDetail[] = [];
  for (const a of exp.requiredArtifacts) {
    let count = 0;
    try {
      const row = sqlite.prepare(a.countSql).get(workflowRunId) as
        | { c: number }
        | undefined;
      count = Number(row?.c ?? 0);
    } catch {
      count = 0;
    }
    const detail: ArtifactGapDetail = {
      table: a.table,
      rows: count,
      minRows: a.minRows,
    };
    rows.push(detail);
    if (count < a.minRows) missing.push(detail);
  }
  return { scenario, ok: missing.length === 0, missing, rows };
}

/**
 * 给 reason 节点回填 prompt 用的人话 hint。
 *
 * 例：scenario=strategy, missing=[strategy_version(0/1), strategy_composition(0/1)]
 *  → "本场景（strategy）要求产物：strategy_version >= 1（当前 0）、
 *     strategy_composition >= 1（当前 0）。你已尝试结束本轮，但产物未落库。
 *     请调用对应落库工具补齐（如 strategy.create_version / strategy.compose），不要返回 tool=none。"
 */
export function buildArtifactGapHint(check: ArtifactCheckResult): string {
  if (check.ok) return "";
  const lines = check.missing
    .map((m) => `${m.table} >= ${m.minRows}（当前 ${m.rows}）`)
    .join("、");
  return [
    `## 产物完整性闸（artifact gate）触发`,
    `本场景（${check.scenario}）要求落库：${lines}。`,
    `你已尝试结束本轮，但产物未落库——评测会判 A-1=0。`,
    `**请调用对应落库工具补齐**（如 strategy.create_version / strategy.compose /`,
    `order.create_intent / 写 analyst_signal 的输出工具），不要返回 \`{"tool":"none"}\`。`,
  ].join("\n");
}
