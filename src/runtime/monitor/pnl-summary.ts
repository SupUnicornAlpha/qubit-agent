/**
 * Self-Evolving Agent P4b — 前端只读 reader：策略层 & skill 层 PnL 视图。
 *
 * 数据源：
 *   strategy_pnl_snapshot（一行 = runtime × day × symbol）
 *   agent_pnl_attribution + agent_skill_run.pnl_delta + agent_skill.pnl_attribution_json
 *
 * 不做任何 fetch / 计算重算 —— 全部走 worker 已物化的快照表，保持读路径极薄。
 * 用于 GET /monitor/pnl/strategies + /monitor/pnl/skills。
 */

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import {
  agentSkill,
  strategyPnlSnapshot,
  strategyRuntime,
} from "../../db/sqlite/schema";

export interface StrategyPnlSummaryInput {
  /** project_id 过滤；不传则不过滤（汇总全部） */
  projectId?: string;
  marketScope?: string[];
  /** ISO 'YYYY-MM-DD'；默认最近 30 天 */
  fromDay?: string;
  toDay?: string;
  /** 仅看指定 runtime；与 projectId/marketScope 任一组合 */
  runtimeIds?: string[];
  /** 前端表格限流 */
  limit?: number;
}

export interface StrategyPnlSummaryRow {
  strategyRuntimeId: string;
  market: string;
  symbol: string;
  /** 期内 daily 累加；不是某一天的 cum，而是范围内总和 */
  realizedPnlSum: number;
  unrealizedPnlSumLast: number;
  feeSum: number;
  turnoverSum: number;
  daysCovered: number;
  /** 最近一天的 (qty, mark_price, market_value) */
  latestDay: string | null;
  latestQty: number | null;
  latestMarkPrice: number | null;
  latestMarketValue: number | null;
}

export async function getStrategyPnlSummary(
  input: StrategyPnlSummaryInput
): Promise<{
  fromDay: string;
  toDay: string;
  rows: StrategyPnlSummaryRow[];
}> {
  const db = await getDb();
  const today = isoToday();
  const fromDay = input.fromDay ?? isoDaysAgo(30);
  const toDay = input.toDay ?? today;

  // 先选 runtime（按 project / market / runtimeIds 过滤）—— 这部分逻辑 reader 收敛
  const rtConditions = [];
  if (input.marketScope && input.marketScope.length > 0) {
    rtConditions.push(inArray(strategyRuntime.market, input.marketScope));
  }
  if (input.runtimeIds && input.runtimeIds.length > 0) {
    rtConditions.push(inArray(strategyRuntime.id, input.runtimeIds));
  }
  // project_id：strategy_runtime → indicator_strategy_script → chat_session →
  // workspace_id；当前 schema 没有直接 runtime.projectId 列，前端要按 project 看时
  // 需要预先拿 runtimeIds 走过来；为简单 v0 暂不过滤 projectId（前端来排）。
  const runtimes = await db
    .select({
      id: strategyRuntime.id,
      market: strategyRuntime.market,
      symbol: strategyRuntime.symbol,
    })
    .from(strategyRuntime)
    .where(rtConditions.length === 0 ? undefined : and(...rtConditions))
    .all();
  if (runtimes.length === 0) {
    return { fromDay, toDay, rows: [] };
  }
  const runtimeIds = runtimes.map((r) => r.id);
  const runtimeMeta = new Map(runtimes.map((r) => [r.id, r]));

  // 主聚合：按 (runtime, symbol) 把范围内日数据汇总
  const aggRows = await db
    .select({
      strategyRuntimeId: strategyPnlSnapshot.strategyRuntimeId,
      symbol: strategyPnlSnapshot.symbol,
      realizedPnlSum: sql<number>`COALESCE(SUM(${strategyPnlSnapshot.realizedPnlDaily}), 0)`.as(
        "realized_pnl_sum"
      ),
      feeSum: sql<number>`COALESCE(SUM(${strategyPnlSnapshot.feeDaily}), 0)`.as("fee_sum"),
      turnoverSum: sql<number>`COALESCE(SUM(${strategyPnlSnapshot.turnoverDaily}), 0)`.as(
        "turnover_sum"
      ),
      daysCovered: sql<number>`COUNT(DISTINCT ${strategyPnlSnapshot.tradingDay})`.as(
        "days_covered"
      ),
      latestDay: sql<string>`MAX(${strategyPnlSnapshot.tradingDay})`.as("latest_day"),
    })
    .from(strategyPnlSnapshot)
    .where(
      and(
        inArray(strategyPnlSnapshot.strategyRuntimeId, runtimeIds),
        gte(strategyPnlSnapshot.tradingDay, fromDay),
        lte(strategyPnlSnapshot.tradingDay, toDay)
      )
    )
    .groupBy(strategyPnlSnapshot.strategyRuntimeId, strategyPnlSnapshot.symbol)
    .all();

  // 二查：拿每个 (runtime, symbol) 最近一天的 qty / mark_price / market_value / unrealized_cum
  const rows: StrategyPnlSummaryRow[] = [];
  for (const a of aggRows) {
    const latest = await db
      .select({
        qty: strategyPnlSnapshot.qty,
        markPrice: strategyPnlSnapshot.markPrice,
        marketValue: strategyPnlSnapshot.marketValue,
        unrealizedPnlCum: strategyPnlSnapshot.unrealizedPnlCum,
      })
      .from(strategyPnlSnapshot)
      .where(
        and(
          eq(strategyPnlSnapshot.strategyRuntimeId, a.strategyRuntimeId),
          eq(strategyPnlSnapshot.symbol, a.symbol),
          eq(strategyPnlSnapshot.tradingDay, a.latestDay)
        )
      )
      .get();
    const meta = runtimeMeta.get(a.strategyRuntimeId);
    rows.push({
      strategyRuntimeId: a.strategyRuntimeId,
      market: meta?.market ?? "?",
      symbol: a.symbol,
      realizedPnlSum: a.realizedPnlSum,
      unrealizedPnlSumLast: latest?.unrealizedPnlCum ?? 0,
      feeSum: a.feeSum,
      turnoverSum: a.turnoverSum,
      daysCovered: a.daysCovered,
      latestDay: a.latestDay ?? null,
      latestQty: latest?.qty ?? null,
      latestMarkPrice: latest?.markPrice ?? null,
      latestMarketValue: latest?.marketValue ?? null,
    });
  }

  rows.sort((x, y) => y.realizedPnlSum + y.unrealizedPnlSumLast - (x.realizedPnlSum + x.unrealizedPnlSumLast));
  const limit = input.limit ?? 200;
  return { fromDay, toDay, rows: rows.slice(0, limit) };
}

// ───────────────────────── skills 视图 ─────────────────────────

export interface SkillPnlSummaryInput {
  projectId: string;
  limit?: number;
}

export interface SkillPnlSummaryRow {
  skillId: string;
  name: string;
  category: string;
  state: string;
  windowDays: number;
  pnlSum: number;
  winCount: number;
  loseCount: number;
  sampleCount: number;
  lastUpdatedAt: string | null;
  useCount: number;
  successCount: number;
  failCount: number;
}

export async function getSkillPnlSummary(
  input: SkillPnlSummaryInput
): Promise<{ projectId: string; rows: SkillPnlSummaryRow[] }> {
  const db = await getDb();
  const rows = await db
    .select({
      id: agentSkill.id,
      name: agentSkill.name,
      category: agentSkill.category,
      state: agentSkill.state,
      pnlAttributionJson: agentSkill.pnlAttributionJson,
      useCount: agentSkill.useCount,
      successCount: agentSkill.successCount,
      failCount: agentSkill.failCount,
    })
    .from(agentSkill)
    .where(eq(agentSkill.projectId, input.projectId))
    .orderBy(desc(agentSkill.useCount))
    .all();

  const out: SkillPnlSummaryRow[] = rows.map((r) => {
    const j = parseRollup(r.pnlAttributionJson);
    return {
      skillId: r.id,
      name: r.name,
      category: r.category,
      state: r.state,
      windowDays: j.windowDays,
      pnlSum: j.pnlSum,
      winCount: j.winCount,
      loseCount: j.loseCount,
      sampleCount: j.sampleCount,
      lastUpdatedAt: j.lastUpdatedAt,
      useCount: r.useCount,
      successCount: r.successCount,
      failCount: r.failCount,
    };
  });
  // 排序：先按 sampleCount > 0 优先，再按 pnlSum desc
  out.sort((a, b) => {
    const aHas = a.sampleCount > 0 ? 1 : 0;
    const bHas = b.sampleCount > 0 ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.pnlSum - a.pnlSum;
  });
  const limit = input.limit ?? 100;
  return { projectId: input.projectId, rows: out.slice(0, limit) };
}

// ───────────────────────── helpers ─────────────────────────

function parseRollup(json: string): {
  windowDays: number;
  pnlSum: number;
  winCount: number;
  loseCount: number;
  sampleCount: number;
  lastUpdatedAt: string | null;
} {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    return {
      windowDays: Number(obj.windowDays ?? 30),
      pnlSum: Number(obj.pnlSum ?? 0),
      winCount: Number(obj.winCount ?? 0),
      loseCount: Number(obj.loseCount ?? 0),
      sampleCount: Number(obj.sampleCount ?? 0),
      lastUpdatedAt: typeof obj.lastUpdatedAt === "string" ? obj.lastUpdatedAt : null,
    };
  } catch {
    return {
      windowDays: 30,
      pnlSum: 0,
      winCount: 0,
      loseCount: 0,
      sampleCount: 0,
      lastUpdatedAt: null,
    };
  }
}

function isoToday(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
