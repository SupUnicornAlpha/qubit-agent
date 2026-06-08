/**
 * A 类 · 内容质量指标（A-1 / A-2 / A-4）。
 *
 * 三个指标都是从 SQL 抓产物，**不调 LLM**：
 *   - A-1 完整性：requiredArtifacts 全部满足 → 1，部分满足 → ratio，全 0 → 0
 *   - A-2 相关性：goal 关键词在产物字段中的命中率
 *   - A-4 一致性：strategy → factor / order → strategy / fusion ↔ signal 引用合法率
 *
 * 设计取舍：
 *   - 完整性用比例（0/0.5/1 三档）而非二值，便于 grader 区分"半成品 workflow"
 *   - A-2 用关键词软匹配避免硬绑 LLM 输出格式；阈值在 thresholds.ts 控制
 *   - A-4 在没有引用关系可校验时返回 null（不算红，避免误伤纯研究 workflow）
 */
import type { Database } from "bun:sqlite";

import {
  getScenarioExpectation,
  type ArtifactExpectation,
  type ConsistencyCheck,
  type ScenarioExpectation,
} from "./scenario-expectations";
import type { ScenarioRecipe } from "../scenarios";

export interface ContentQualityInput {
  workflowRunId: string;
  scenario: ScenarioRecipe["key"];
  /** workflow_run.goal —— 用于 A-2 关键词命中 */
  goal: string;
}

export interface ContentQualityResult {
  "A-1": number;
  "A-2": number;
  "A-4": number | null;
  /** 调试用：每个 artifact 是否达标 */
  details: {
    artifacts: ReadonlyArray<{ table: string; ok: boolean; rows: number }>;
    keywordsMatched: ReadonlyArray<string>;
    keywordsMissed: ReadonlyArray<string>;
    consistency: ReadonlyArray<{
      name: string;
      totalRefs: number;
      brokenRefs: number;
    }>;
  };
}

// ── A-1 ────────────────────────────────────────────────────────────────────

function evaluateArtifact(
  sqlite: Database,
  workflowRunId: string,
  artifact: ArtifactExpectation
): { ok: boolean; rows: number } {
  // countSql 里的 ? 占位符 = workflowRunId
  const row = sqlite.prepare(artifact.countSql).get(workflowRunId) as
    | { c: number }
    | undefined;
  const rows = Number(row?.c ?? 0);
  return { ok: rows >= artifact.minRows, rows };
}

function metricA1(
  sqlite: Database,
  workflowRunId: string,
  exp: ScenarioExpectation
): { value: number; details: ContentQualityResult["details"]["artifacts"] } {
  if (!exp.requiredArtifacts.length) {
    return { value: 1, details: [] };
  }
  // 二值语义：每个 artifact 只判"是否非空"（rows > 0），用比例聚合。
  // minRows 不进入分数（避免"差 1 条 = 半绿"的违反直觉），只在 details 里给 reporter 展示完美标准。
  const checks = exp.requiredArtifacts.map((a) => ({
    table: a.table,
    minRows: a.minRows,
    ...evaluateArtifact(sqlite, workflowRunId, a),
  }));
  const filled = checks.filter((c) => c.rows > 0).length;
  return {
    value: filled / exp.requiredArtifacts.length,
    details: checks.map((c) => ({ table: c.table, ok: c.ok, rows: c.rows })),
  };
}

// ── A-2 ────────────────────────────────────────────────────────────────────

const TICKER_RX = /\b[A-Z]{2,5}\b/g;

function extractKeywords(goal: string, declared: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const k of declared) {
    if (k.trim()) out.add(k.trim());
  }
  // 额外把 goal 里的"看起来是 ticker"的大写字母组也吸进来——避免 keywords 配置漏掉
  for (const m of goal.matchAll(TICKER_RX)) {
    if (!["READINESS", "AGENT", "API", "USA"].includes(m[0])) {
      out.add(m[0]);
    }
  }
  return [...out];
}

/**
 * 把场景里所有"叙事性"产物字段一次拼成大字符串，用于检查关键词命中。
 *
 * 仅取易解释的字段（reasoning / ticker / fused_signal / 因子表达式 / 候选股代码 / order）。
 * 避免抓 JSON blob 里的随机字段污染匹配。
 */
function fetchSearchHaystack(
  sqlite: Database,
  workflowRunId: string,
  scenario: ScenarioRecipe["key"]
): string {
  const parts: string[] = [];
  if (scenario === "research") {
    const sigs = sqlite
      .prepare(
        `SELECT ticker, reasoning, signal FROM analyst_signal WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ ticker: string; reasoning: string; signal: string }>;
    for (const s of sigs) parts.push(s.ticker, s.reasoning, s.signal);
    const fus = sqlite
      .prepare(
        `SELECT ticker, fused_signal AS sig FROM signal_fusion_result WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ ticker: string; sig: string }>;
    for (const f of fus) parts.push(f.ticker, f.sig);
  } else if (scenario === "stock_pick") {
    const cands = sqlite
      .prepare(
        `SELECT sc.ticker, sc.company_name AS company
         FROM screener_candidate sc
         JOIN screener_run sr ON sr.id = sc.screener_run_id
         WHERE sr.workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ ticker: string; company: string }>;
    for (const c of cands) parts.push(c.ticker, c.company);
  } else if (scenario === "factor") {
    const facs = sqlite
      .prepare(
        `SELECT name, expr, category FROM factor_definition
         WHERE id IN (SELECT factor_id FROM factor_evaluation)`
      )
      .all() as Array<{ name: string; expr: string; category: string }>;
    for (const f of facs) parts.push(f.name, f.expr, f.category);
  } else if (scenario === "strategy") {
    const vers = sqlite
      .prepare(
        `SELECT version_tag AS tag FROM strategy_version WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ tag: string }>;
    for (const v of vers) parts.push(v.tag);
  } else if (scenario === "live_trading") {
    const ois = sqlite
      .prepare(
        `SELECT oi.side, oi.order_type AS ot, i.symbol
         FROM order_intent oi JOIN instrument i ON i.id = oi.instrument_id
         WHERE oi.workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ side: string; ot: string; symbol: string }>;
    for (const o of ois) parts.push(o.side, o.ot, o.symbol);
  }
  return parts.join(" ").toLowerCase();
}

function metricA2(
  sqlite: Database,
  input: ContentQualityInput,
  exp: ScenarioExpectation
): { value: number; matched: string[]; missed: string[] } {
  const keywords = extractKeywords(input.goal, exp.goalKeywords);
  if (!keywords.length) return { value: 1, matched: [], missed: [] };
  const haystack = fetchSearchHaystack(sqlite, input.workflowRunId, input.scenario);
  if (!haystack) {
    return { value: 0, matched: [], missed: keywords };
  }
  const matched: string[] = [];
  const missed: string[] = [];
  for (const k of keywords) {
    if (haystack.includes(k.toLowerCase())) matched.push(k);
    else missed.push(k);
  }
  return { value: matched.length / keywords.length, matched, missed };
}

// ── A-4 ────────────────────────────────────────────────────────────────────

function checkConsistency(
  sqlite: Database,
  workflowRunId: string,
  check: ConsistencyCheck
): { totalRefs: number; brokenRefs: number } {
  if (check.kind === "strategy_factor_refs") {
    // 取本 workflow 所有 strategy_composition 的 factorIdsJson，每个 id 都应该在 factor_definition 里
    const rows = sqlite
      .prepare(
        `SELECT sc.factor_ids_json AS j
         FROM strategy_composition sc
         JOIN strategy_version sv ON sv.id = sc.strategy_version_id
         WHERE sv.workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ j: string }>;
    let total = 0;
    let broken = 0;
    for (const r of rows) {
      let ids: unknown;
      try {
        ids = typeof r.j === "string" ? JSON.parse(r.j) : r.j;
      } catch {
        ids = [];
      }
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (typeof id !== "string") continue;
        total++;
        const exists = sqlite
          .prepare(`SELECT 1 FROM factor_definition WHERE id = ? LIMIT 1`)
          .get(id);
        if (!exists) broken++;
      }
    }
    return { totalRefs: total, brokenRefs: broken };
  }

  if (check.kind === "order_strategy_refs") {
    const rows = sqlite
      .prepare(
        `SELECT strategy_version_id AS sv FROM order_intent WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ sv: string }>;
    let total = 0;
    let broken = 0;
    for (const r of rows) {
      total++;
      const exists = sqlite
        .prepare(`SELECT 1 FROM strategy_version WHERE id = ? LIMIT 1`)
        .get(r.sv);
      if (!exists) broken++;
    }
    return { totalRefs: total, brokenRefs: broken };
  }

  if (check.kind === "fusion_signal_refs") {
    // signal_fusion_result.ticker 在本 workflow 至少有一条 analyst_signal 提到
    const rows = sqlite
      .prepare(
        `SELECT ticker FROM signal_fusion_result WHERE workflow_run_id = ?`
      )
      .all(workflowRunId) as Array<{ ticker: string }>;
    let total = 0;
    let broken = 0;
    for (const r of rows) {
      total++;
      const exists = sqlite
        .prepare(
          `SELECT 1 FROM analyst_signal WHERE workflow_run_id = ? AND ticker = ? LIMIT 1`
        )
        .get(workflowRunId, r.ticker);
      if (!exists) broken++;
    }
    return { totalRefs: total, brokenRefs: broken };
  }

  return { totalRefs: 0, brokenRefs: 0 };
}

function metricA4(
  sqlite: Database,
  workflowRunId: string,
  exp: ScenarioExpectation
):
  | { value: number; details: ContentQualityResult["details"]["consistency"] }
  | { value: null; details: ContentQualityResult["details"]["consistency"] } {
  if (!exp.consistencyChecks.length) {
    return { value: null, details: [] };
  }
  let total = 0;
  let broken = 0;
  const details: ContentQualityResult["details"]["consistency"] = [];
  for (const c of exp.consistencyChecks) {
    const r = checkConsistency(sqlite, workflowRunId, c);
    total += r.totalRefs;
    broken += r.brokenRefs;
    details.push({ name: c.name, totalRefs: r.totalRefs, brokenRefs: r.brokenRefs });
  }
  if (total === 0) return { value: null, details };
  return { value: 1 - broken / total, details };
}

// ── 汇总 ───────────────────────────────────────────────────────────────────

export async function collectContentQuality(
  sqlite: Database,
  input: ContentQualityInput
): Promise<ContentQualityResult> {
  const exp = getScenarioExpectation(input.scenario);
  const a1 = metricA1(sqlite, input.workflowRunId, exp);
  const a2 = metricA2(sqlite, input, exp);
  const a4 = metricA4(sqlite, input.workflowRunId, exp);
  return {
    "A-1": a1.value,
    "A-2": a2.value,
    "A-4": a4.value,
    details: {
      artifacts: a1.details,
      keywordsMatched: a2.matched,
      keywordsMissed: a2.missed,
      consistency: a4.details,
    },
  };
}
