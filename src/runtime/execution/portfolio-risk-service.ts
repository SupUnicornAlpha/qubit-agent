import { queryBarsRange } from "../market/klines-query";
import { resolveTickerMarket } from "../market/resolve-ticker-market";
import { validatePointInTimeBars } from "../market/point-in-time-contract";
import type {
  PortfolioAllocationRow,
  PortfolioCandidate,
} from "./portfolio-allocation-service";

export interface PortfolioRiskMetrics {
  observations: number;
  historicalVar95Pct: number;
  historicalVar99Pct: number;
  expectedShortfall95Pct: number;
  expectedShortfall99Pct: number;
  annualizedVolatilityPct: number;
  historicalMaxDrawdownPct: number;
}

export interface PortfolioStressResult {
  scenario: string;
  portfolioReturnPct: number;
  lossAmount: number;
  contributions: Record<string, number>;
}

export interface PortfolioRiskReport {
  asof: string;
  status: "ready" | "insufficient_data";
  metrics: PortfolioRiskMetrics | null;
  correlationMatrix: Record<string, Record<string, number>>;
  covarianceMatrix: Record<string, Record<string, number>>;
  weightedAverageCorrelation: number | null;
  stressTests: PortfolioStressResult[];
  lineage: Array<{
    symbol: string;
    exchange: string;
    bars: number;
    firstAsof: string | null;
    lastAsof: string | null;
    status: "used" | "insufficient" | "error";
    error?: string;
  }>;
  warnings: string[];
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function quantile(sorted: number[], probability: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function covariance(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2) return 0;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  return left.reduce(
    (sum, value, index) => sum + (value - leftMean) * (right[index]! - rightMean),
    0,
  ) / (left.length - 1);
}

export function analyzeHistoricalPortfolioRisk(returns: number[]): PortfolioRiskMetrics | null {
  const clean = returns.filter(Number.isFinite);
  if (clean.length < 30) return null;
  const losses = clean.map((value) => -value).sort((a, b) => a - b);
  const var95 = Math.max(0, quantile(losses, 0.95));
  const var99 = Math.max(0, quantile(losses, 0.99));
  const tail95 = losses.filter((loss) => loss >= var95);
  const tail99 = losses.filter((loss) => loss >= var99);
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of clean) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1);
  }
  return {
    observations: clean.length,
    historicalVar95Pct: round(var95),
    historicalVar99Pct: round(var99),
    expectedShortfall95Pct: round(tail95.reduce((sum, value) => sum + value, 0) / tail95.length),
    expectedShortfall99Pct: round(tail99.reduce((sum, value) => sum + value, 0) / tail99.length),
    annualizedVolatilityPct: round(standardDeviation(clean) * Math.sqrt(252)),
    historicalMaxDrawdownPct: round(Math.abs(maxDrawdown)),
  };
}

export function runPortfolioStressTests(input: {
  capital: number;
  rows: PortfolioAllocationRow[];
  candidates: PortfolioCandidate[];
}): PortfolioStressResult[] {
  const candidateBySymbol = new Map(input.candidates.map((candidate) => [candidate.symbol.trim().toUpperCase(), candidate]));
  const scenarios: Array<{
    name: string;
    shock: (row: PortfolioAllocationRow, candidate?: PortfolioCandidate) => number;
  }> = [
    { name: "market_crash_20", shock: (row) => -0.2 * Math.max(0.5, Math.abs(row.beta)) },
    { name: "market_rally_15", shock: (row) => 0.15 * Math.max(0.5, Math.abs(row.beta)) },
    {
      name: "growth_selloff_15",
      shock: (_row, candidate) => -0.15 * Math.max(0, candidate?.styleExposures?.growth ?? 0),
    },
    {
      name: "momentum_reversal_12",
      shock: (_row, candidate) => -0.12 * Math.abs(candidate?.factorExposures?.momentum ?? 0),
    },
  ];
  return scenarios.map((scenario) => {
    const contributions: Record<string, number> = {};
    let portfolioReturn = 0;
    for (const row of input.rows) {
      const candidate = candidateBySymbol.get(row.symbol);
      const contribution = row.targetWeight * scenario.shock(row, candidate);
      contributions[row.symbol] = round(contribution);
      portfolioReturn += contribution;
    }
    return {
      scenario: scenario.name,
      portfolioReturnPct: round(portfolioReturn),
      lossAmount: round(Math.max(0, -portfolioReturn * input.capital), 2),
      contributions,
    };
  });
}

export async function buildHistoricalPortfolioRisk(input: {
  capital: number;
  rows: PortfolioAllocationRow[];
  candidates: PortfolioCandidate[];
  lookbackCalendarDays?: number;
  minimumObservations?: number;
  fetchBars?: typeof queryBarsRange;
}): Promise<PortfolioRiskReport> {
  const end = new Date();
  const start = new Date(end.getTime() - (input.lookbackCalendarDays ?? 400) * 86_400_000);
  const fetchBars = input.fetchBars ?? queryBarsRange;
  const returnsBySymbol = new Map<string, Map<string, number>>();
  const lineage: PortfolioRiskReport["lineage"] = [];
  await Promise.all(input.rows.map(async (row) => {
    const resolution = resolveTickerMarket(row.symbol);
    try {
      const bars = await fetchBars({
        symbol: resolution.symbol,
        exchange: resolution.exchange === "UNKNOWN" ? "" : resolution.exchange,
        period: "1d",
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      });
      const fetchedAt = new Date().toISOString();
      const validated = validatePointInTimeBars(bars, {
        provider: "qubit-data",
        fetchedAt,
        dataAsof: fetchedAt,
        adjustType: "none",
        security: {
          symbol: resolution.symbol,
          exchange: resolution.exchange,
          listingStatus: "active",
        },
      });
      if (!validated.valid) {
        throw new Error(`point_in_time_contract_failed:${validated.errors.join(",")}`);
      }
      const validBars = validated.bars;
      const values = new Map<string, number>();
      for (let index = 1; index < validBars.length; index += 1) {
        const previous = validBars[index - 1]!.close;
        const current = validBars[index]!.close;
        if (previous > 0 && Number.isFinite(current)) {
          values.set(validBars[index]!.timestamp.slice(0, 10), current / previous - 1);
        }
      }
      returnsBySymbol.set(row.symbol, values);
      lineage.push({
        symbol: row.symbol,
        exchange: resolution.exchange,
        bars: validBars.length,
        firstAsof: validBars[0]?.timestamp ?? null,
        lastAsof: validBars.at(-1)?.timestamp ?? null,
        status: values.size >= (input.minimumObservations ?? 30) ? "used" : "insufficient",
      });
    } catch (error) {
      lineage.push({
        symbol: row.symbol,
        exchange: resolution.exchange,
        bars: 0,
        firstAsof: null,
        lastAsof: null,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }));

  const usableRows = input.rows.filter((row) => {
    const values = returnsBySymbol.get(row.symbol);
    return values && values.size >= (input.minimumObservations ?? 30);
  });
  const commonDates = usableRows.length
    ? [...returnsBySymbol.get(usableRows[0]!.symbol)!.keys()].filter((date) =>
        usableRows.every((row) => returnsBySymbol.get(row.symbol)!.has(date)))
    : [];
  const portfolioReturns = commonDates.sort().map((date) =>
    usableRows.reduce(
      (sum, row) => sum + row.targetWeight * returnsBySymbol.get(row.symbol)!.get(date)!,
      0,
    ));
  const correlationMatrix: Record<string, Record<string, number>> = {};
  const covarianceMatrix: Record<string, Record<string, number>> = {};
  let weightedCorrelationSum = 0;
  let weightedCorrelationWeight = 0;
  for (let leftIndex = 0; leftIndex < usableRows.length; leftIndex += 1) {
    const left = usableRows[leftIndex]!;
    correlationMatrix[left.symbol] = {};
    covarianceMatrix[left.symbol] = {};
    const leftReturns = commonDates.map((date) => returnsBySymbol.get(left.symbol)!.get(date)!);
    for (let rightIndex = 0; rightIndex < usableRows.length; rightIndex += 1) {
      const right = usableRows[rightIndex]!;
      const rightReturns = commonDates.map((date) => returnsBySymbol.get(right.symbol)!.get(date)!);
      const pairCovariance = covariance(leftReturns, rightReturns);
      const denominator = standardDeviation(leftReturns) * standardDeviation(rightReturns);
      const pairCorrelation = denominator > 0 ? pairCovariance / denominator : leftIndex === rightIndex ? 1 : 0;
      covarianceMatrix[left.symbol]![right.symbol] = round(pairCovariance, 10);
      correlationMatrix[left.symbol]![right.symbol] = round(pairCorrelation);
      if (rightIndex > leftIndex) {
        const pairWeight = Math.abs(left.targetWeight * right.targetWeight);
        weightedCorrelationSum += pairCorrelation * pairWeight;
        weightedCorrelationWeight += pairWeight;
      }
    }
  }
  const metrics = analyzeHistoricalPortfolioRisk(portfolioReturns);
  const warnings: string[] = [];
  if (usableRows.length < input.rows.length) warnings.push("some symbols were excluded from historical risk due to insufficient bars");
  if (!metrics) warnings.push("historical VaR/ES requires at least 30 aligned observations");
  return {
    asof: new Date().toISOString(),
    status: metrics ? "ready" : "insufficient_data",
    metrics,
    correlationMatrix,
    covarianceMatrix,
    weightedAverageCorrelation: weightedCorrelationWeight > 0
      ? round(weightedCorrelationSum / weightedCorrelationWeight)
      : null,
    stressTests: runPortfolioStressTests(input),
    lineage: lineage.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    warnings,
  };
}
