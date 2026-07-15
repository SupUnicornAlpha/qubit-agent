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
import type { ScenarioRecipe } from "../scenarios";
import { SCENARIO_EXPECTATIONS, getScenarioExpectation } from "./scenario-expectations";

export interface ArtifactGapDetail {
  table: string;
  rows: number;
  minRows: number;
  status?: "warming" | "passed" | "failed";
  detail?: string;
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
    const aliases: Record<string, ScenarioRecipe["key"]> = {
      analyst_debate: "research",
      stock_screening: "stock_pick",
      factor_research: "factor",
      strategy_authoring: "strategy",
      live_trading: "live_trading",
    };
    if (aliases[raw]) return aliases[raw];
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
  for (const a of [...exp.requiredArtifacts, ...(exp.qualityGates ?? [])]) {
    let count = 0;
    try {
      const row = sqlite.prepare(a.countSql).get(workflowRunId) as { c: number } | undefined;
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
  if (scenario === "stock_pick" || scenario === "stock_pick_short") {
    const effect = checkRecommendationEffectGate(sqlite, workflowRunId, {
      side: scenario === "stock_pick" ? "long" : "short",
    });
    rows.push(effect);
    if (effect.status === "failed") missing.push(effect);
  }
  return { scenario, ok: missing.length === 0, missing, rows };
}

export function checkRecommendationEffectGate(
  sqlite: Database,
  workflowRunId: string,
  input: {
    side: "long" | "short";
    minMature?: number;
    minWinRate?: number;
    minAverageExcessReturnPct?: number;
    maxBrierScore?: number;
  }
): ArtifactGapDetail {
  const minMature = input.minMature ?? 50;
  try {
    const row = sqlite
      .prepare(
        `SELECT
          COUNT(*) AS mature,
          AVG(CASE WHEN ro.outcome = 'win' THEN 1.0 ELSE 0.0 END) AS win_rate,
          AVG(ro.excess_return_pct) AS avg_excess,
          AVG((rs.confidence - CASE WHEN ro.outcome = 'win' THEN 1.0 ELSE 0.0 END) *
              (rs.confidence - CASE WHEN ro.outcome = 'win' THEN 1.0 ELSE 0.0 END)) AS brier
        FROM recommendation_snapshot rs
        JOIN recommendation_outcome ro ON ro.recommendation_id = rs.id
        WHERE rs.project_id = (
          SELECT project_id FROM workflow_run WHERE id = ?
        )
          AND rs.side = ?
          AND ro.horizon_days = 20
          AND ro.outcome IN ('win', 'loss', 'flat')`
      )
      .get(workflowRunId, input.side) as
      | { mature: number; win_rate: number | null; avg_excess: number | null; brier: number | null }
      | undefined;
    const mature = Number(row?.mature ?? 0);
    const winRate = Number(row?.win_rate ?? 0);
    const averageExcess = Number(row?.avg_excess ?? 0);
    const brier = Number(row?.brier ?? 1);
    if (mature < minMature) {
      return {
        table: "quality:recommendation_effect",
        rows: 1,
        minRows: 1,
        status: "warming",
        detail: `mature=${mature}/${minMature}`,
      };
    }
    const pass =
      winRate >= (input.minWinRate ?? 0.5) &&
      averageExcess >= (input.minAverageExcessReturnPct ?? 0) &&
      brier <= (input.maxBrierScore ?? 0.25);
    return {
      table: "quality:recommendation_effect",
      rows: pass ? 1 : 0,
      minRows: 1,
      status: pass ? "passed" : "failed",
      detail: `mature=${mature}, winRate=${winRate.toFixed(3)}, avgExcess=${averageExcess.toFixed(3)}, brier=${brier.toFixed(3)}`,
    };
  } catch (error) {
    return {
      table: "quality:recommendation_effect",
      rows: 1,
      minRows: 1,
      status: "warming",
      detail: `effect_data_unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
    .map((m) => `${m.table} >= ${m.minRows}（当前 ${m.rows}${m.detail ? `；${m.detail}` : ""}）`)
    .join("、");
  const recoveryByScenario: Partial<Record<ScenarioRecipe["key"], string>> = {
    factor:
      "恢复顺序：先 factor.list 找本 workflow 的 factor_id；没有则 factor.register；随后 factor.compute 写入非零 factor_value；最后 factor.autoEvaluate 写 factor_evaluation。若 compute 返回 no_factor_values_written，切换数据源/市场/symbols 后最多重试一次，仍为空就明确失败。",
    stock_pick:
      "恢复顺序：先 run_screener 生成候选，再逐只 recommendation.record 写入推荐与交易计划。若所有行情源都无数据，不得改做 strategy/factor 产物来冒充选股结果，应明确失败并报告阻塞。",
    stock_pick_short:
      "恢复顺序：先 run_screener 生成做空候选，再逐只 recommendation.record(side=short) 写入推荐与交易计划。若所有行情源都无数据，应明确失败并报告阻塞。",
    strategy:
      "恢复顺序：strategy.create_version 后调用 strategy.compose；若因子权重依赖评估，先补 factor.autoEvaluate，不得只输出 Markdown 策略。",
    strategy_long_short:
      "恢复顺序：strategy.create_version 后调用 strategy.compose，并确保 long/short 两端及仓位约束真实落库。",
    live_trading:
      "恢复顺序：验证 strategy 与 broker account 后调用 order.create_intent；风险或数据校验不通过时明确失败，不得伪造订单。",
    live_trading_short:
      "恢复顺序：验证 strategy 与 broker account 后调用 order.create_intent(side=short)；风险或数据校验不通过时明确失败。",
  };
  return [
    "## 产物完整性闸（artifact gate）触发",
    `本场景（${check.scenario}）要求落库：${lines}。`,
    "你已尝试结束本轮，但产物未落库——评测会判 A-1=0。",
    recoveryByScenario[check.scenario] ??
      "请调用场景对应的落库工具补齐；若外部数据不可用且没有可信替代源，明确失败并报告阻塞。",
    `不要返回 \`{"tool":"none"}\`，也不要用其它类型产物代替本场景合同。`,
  ].join("\n");
}
