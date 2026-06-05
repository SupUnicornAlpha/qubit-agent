import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { screenerCandidate, screenerRun } from "../../db/sqlite/schema";
import {
  STOCK_UNIVERSE,
  type StockUniverseKey,
  type UniverseStock,
} from "./universe-pool";

export interface ScreenerInput {
  workflowRunId: string;
  /**
   * 2026-06-05 监控复盘 #4 / C：扩展 universe 选项。
   * 旧版只有 CN-A / US / HK；新增 ALL / CRYPTO，让 explore 类任务可一次拿到
   * 跨市场候选。默认 ALL（最不挑剔，LLM 自己用 country / sector 进一步筛）。
   */
  universe?: StockUniverseKey | "ALL";
  criteria?: {
    minMarketCapBillion?: number;
    maxPe?: number;
    minMomentum30d?: number;
    /** 板块（"Tech" / "Financials" / "Healthcare" / "Consumer" / "Energy" / ...），大小写不敏感 */
    sector?: string;
    /** 子行业（"Semiconductors" / "Software" / "Banks" / "Pharma" / ...），子串包含匹配 */
    industry?: string;
    /** 国家二级筛选（"US" / "CN" / "HK" / "CRYPTO"） */
    country?: string;
    minQuality?: number;
    minSentiment?: number;
  };
  topN?: number;
}

export interface ScreenerCandidateResult {
  ticker: string;
  companyName: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  /** 暴露 sector / industry / country 让分析师看到候选的板块信息 */
  meta?: {
    sector: string;
    industry: string;
    country: string;
    marketCapBillion: number;
  };
}

export interface ScreenerRunResult {
  screenerRunId: string;
  universe: string;
  candidateCount: number;
  /** 池中通过 criteria 过滤的总数（topN 之前） */
  matchedBeforeTopN: number;
  /** universe 池总规模（用于 LLM 判断 criteria 是不是太严） */
  universeSize: number;
  candidates: ScreenerCandidateResult[];
  /** 当 candidates 为空时，给 LLM 的 actionable 提示 */
  hint?: string;
}

function inUniverse(stock: UniverseStock, universe: StockUniverseKey | "ALL"): boolean {
  if (universe === "ALL") return true;
  if (universe === "CN-A") return stock.country === "CN";
  if (universe === "US") return stock.country === "US";
  if (universe === "HK") return stock.country === "HK";
  if (universe === "CRYPTO") return stock.country === "CRYPTO";
  return true;
}

function scoreStock(stock: UniverseStock): ScreenerCandidateResult {
  // 简化版综合评分：质量 35% + 动量 30% + 估值 20% + 情绪 15%
  const qualityScore = stock.quality;
  const momentumScore = Math.max(0, Math.min(1, (stock.momentum30d + 0.1) / 0.3));
  const valuationScore = Math.max(0, Math.min(1, 1 - stock.pe / 60));
  const sentimentScore = stock.sentiment;

  const finalScore =
    qualityScore * 0.35 +
    momentumScore * 0.3 +
    valuationScore * 0.2 +
    sentimentScore * 0.15;

  return {
    ticker: stock.ticker,
    companyName: stock.companyName,
    score: Number(finalScore.toFixed(4)),
    scoreBreakdown: {
      quality: Number(qualityScore.toFixed(4)),
      momentum: Number(momentumScore.toFixed(4)),
      valuation: Number(valuationScore.toFixed(4)),
      sentiment: Number(sentimentScore.toFixed(4)),
    },
    meta: {
      sector: stock.sector,
      industry: stock.industry,
      country: stock.country,
      marketCapBillion: stock.marketCapBillion,
    },
  };
}

/**
 * 2026-06-05 监控复盘 #4 / C：first-pass screener。
 *
 * 旧版 stub 只有 10 个 hardcoded mock 股 → "AI 半导体的机会"这种探索类需求
 * 拿不到任何候选 → LLM 死循环。新版：
 *   - 200+ 真实 ticker（US S&P/NDX 头部 + CN 沪深300 头部 + HK 恒指/恒科 + Crypto）
 *   - 加 sector / industry / country 过滤维度
 *   - universe 新增 "ALL"（默认）+ "CRYPTO"
 *   - criteria 新增 sector / industry / country / minQuality / minSentiment
 *   - matchedBeforeTopN / universeSize / hint 帮 LLM 调整 criteria
 *
 * 数值（marketCap/pe/momentum）是粗略量级（first-pass 用），后续 fetch_klines /
 * fetch_fundamentals 拿真实数据再做精确分析。
 */
export async function runStockScreener(input: ScreenerInput): Promise<ScreenerRunResult> {
  const db = await getDb();
  const universe = input.universe ?? "ALL";
  const criteria = input.criteria ?? {};
  const topN = Math.max(1, Math.min(50, input.topN ?? 5));

  const sectorFilter = criteria.sector?.trim().toLowerCase();
  const industryFilterRaw = criteria.industry?.trim();
  /**
   * 用 word-boundary 而不是 includes：之前 includes 让 `industry:"AI"` 误匹配
   * `Retail`（含子串 "ai" at 3-4 位）/`Dairy`（含 "ai" at 1-2 位）等。
   * `\bSemi` 仍可匹配 "Semiconductors" / "Semi Equipment"；`\bAI` 只匹配
   * "AI/Software" 等真以 AI 起头的 industry。
   */
  const industryRegex = industryFilterRaw
    ? new RegExp(`\\b${industryFilterRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i")
    : undefined;
  const countryFilter = criteria.country?.trim().toUpperCase();

  const filtered = STOCK_UNIVERSE.filter((s) => {
    if (!inUniverse(s, universe)) return false;
    if (countryFilter && s.country !== countryFilter) return false;
    if (sectorFilter && s.sector.toLowerCase() !== sectorFilter) return false;
    if (industryRegex && !industryRegex.test(s.industry)) return false;
    if (typeof criteria.minMarketCapBillion === "number" && s.marketCapBillion < criteria.minMarketCapBillion) return false;
    if (typeof criteria.maxPe === "number" && s.pe > 0 && s.pe > criteria.maxPe) return false;
    if (typeof criteria.minMomentum30d === "number" && s.momentum30d < criteria.minMomentum30d) return false;
    if (typeof criteria.minQuality === "number" && s.quality < criteria.minQuality) return false;
    if (typeof criteria.minSentiment === "number" && s.sentiment < criteria.minSentiment) return false;
    return true;
  });

  const scored = filtered.map(scoreStock).sort((a, b) => b.score - a.score).slice(0, topN);

  const runId = randomUUID();
  await db.insert(screenerRun).values({
    id: runId,
    workflowRunId: input.workflowRunId,
    criteriaJson: criteria,
    universe,
    candidateCount: scored.length,
  });

  for (const candidate of scored) {
    await db.insert(screenerCandidate).values({
      id: randomUUID(),
      screenerRunId: runId,
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      score: candidate.score,
      scoreBreakdownJson: candidate.scoreBreakdown,
      passedToAnalyst: true,
    });
  }

  let hint: string | undefined;
  if (scored.length === 0) {
    hint =
      `0 个候选命中（universe=${universe} 池中 ${STOCK_UNIVERSE.length} 只；filter 后 ${filtered.length} 只）。` +
      `建议放宽 criteria（移除 sector/industry 或调低 minMarketCapBillion / minMomentum30d / minQuality）` +
      `；或试 universe="ALL" / 切换 country 维度。可参考的 sector 取值：Tech, Financials, Healthcare, Consumer, Energy, ` +
      `Industrials, Materials, REIT, Utilities, Telecom, Crypto。`;
  }

  return {
    screenerRunId: runId,
    universe,
    candidateCount: scored.length,
    matchedBeforeTopN: filtered.length,
    universeSize: STOCK_UNIVERSE.length,
    candidates: scored,
    ...(hint ? { hint } : {}),
  };
}

export async function listScreenerRuns(workflowRunId: string) {
  const db = await getDb();
  return db.select().from(screenerRun).where(eq(screenerRun.workflowRunId, workflowRunId)).orderBy(desc(screenerRun.createdAt));
}

export async function listScreenerCandidates(screenerRunId: string) {
  const db = await getDb();
  return db
    .select()
    .from(screenerCandidate)
    .where(eq(screenerCandidate.screenerRunId, screenerRunId))
    .orderBy(desc(screenerCandidate.score));
}
