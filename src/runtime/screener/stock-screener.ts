import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { screenerCandidate, screenerRun } from "../../db/sqlite/schema";

export interface ScreenerInput {
  workflowRunId: string;
  universe?: "CN-A" | "US" | "HK";
  criteria?: {
    minMarketCapBillion?: number;
    maxPe?: number;
    minMomentum30d?: number;
  };
  topN?: number;
}

export interface ScreenerCandidateResult {
  ticker: string;
  companyName: string;
  score: number;
  scoreBreakdown: Record<string, number>;
}

export interface ScreenerRunResult {
  screenerRunId: string;
  universe: string;
  candidateCount: number;
  candidates: ScreenerCandidateResult[];
}

type MockStock = {
  ticker: string;
  companyName: string;
  marketCapBillion: number;
  pe: number;
  momentum30d: number;
  quality: number;
  sentiment: number;
};

const MOCK_STOCKS: MockStock[] = [
  { ticker: "600519", companyName: "贵州茅台", marketCapBillion: 2200, pe: 28, momentum30d: 0.09, quality: 0.95, sentiment: 0.72 },
  { ticker: "000858", companyName: "五粮液", marketCapBillion: 650, pe: 21, momentum30d: 0.06, quality: 0.88, sentiment: 0.64 },
  { ticker: "300750", companyName: "宁德时代", marketCapBillion: 980, pe: 24, momentum30d: 0.12, quality: 0.9, sentiment: 0.7 },
  { ticker: "601318", companyName: "中国平安", marketCapBillion: 820, pe: 9, momentum30d: 0.03, quality: 0.84, sentiment: 0.52 },
  { ticker: "600036", companyName: "招商银行", marketCapBillion: 930, pe: 8, momentum30d: 0.02, quality: 0.86, sentiment: 0.49 },
  { ticker: "AAPL", companyName: "Apple Inc.", marketCapBillion: 2900, pe: 31, momentum30d: 0.08, quality: 0.96, sentiment: 0.73 },
  { ticker: "MSFT", companyName: "Microsoft Corp.", marketCapBillion: 3200, pe: 34, momentum30d: 0.07, quality: 0.97, sentiment: 0.71 },
  { ticker: "NVDA", companyName: "NVIDIA Corp.", marketCapBillion: 2500, pe: 42, momentum30d: 0.16, quality: 0.94, sentiment: 0.82 },
  { ticker: "0700.HK", companyName: "腾讯控股", marketCapBillion: 3800, pe: 22, momentum30d: 0.05, quality: 0.91, sentiment: 0.66 },
  { ticker: "9988.HK", companyName: "阿里巴巴", marketCapBillion: 1500, pe: 14, momentum30d: 0.04, quality: 0.78, sentiment: 0.58 },
];

function inUniverse(stock: MockStock, universe: string): boolean {
  if (universe === "CN-A") return /^\d{6}$/.test(stock.ticker);
  if (universe === "US") return /^[A-Z]{1,5}$/.test(stock.ticker);
  if (universe === "HK") return /\.HK$/.test(stock.ticker);
  return true;
}

function scoreStock(stock: MockStock): ScreenerCandidateResult {
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
  };
}

export async function runStockScreener(input: ScreenerInput): Promise<ScreenerRunResult> {
  const db = await getDb();
  const universe = input.universe ?? "CN-A";
  const criteria = input.criteria ?? {};
  const topN = Math.max(1, Math.min(50, input.topN ?? 5));

  const filtered = MOCK_STOCKS.filter((s) => {
    if (!inUniverse(s, universe)) return false;
    if (typeof criteria.minMarketCapBillion === "number" && s.marketCapBillion < criteria.minMarketCapBillion) {
      return false;
    }
    if (typeof criteria.maxPe === "number" && s.pe > criteria.maxPe) return false;
    if (typeof criteria.minMomentum30d === "number" && s.momentum30d < criteria.minMomentum30d) return false;
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

  return {
    screenerRunId: runId,
    universe,
    candidateCount: scored.length,
    candidates: scored,
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
