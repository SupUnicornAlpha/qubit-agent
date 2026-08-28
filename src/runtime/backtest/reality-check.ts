import { createHash } from "node:crypto";
import type { BacktestEquityPoint } from "../provider/types";

export interface RealityCheckCandidate {
  id: string;
  equityCurve: BacktestEquityPoint[];
}

export interface WhiteRealityCheckReport {
  version: "white-reality-check-v1";
  status: "passed" | "research_only";
  benchmark: "backtest_benchmark" | "cash_zero_return";
  candidateCount: number;
  sampleSize: number;
  simulations: number;
  blockSize: number;
  seed: number;
  bestCandidateId: string | null;
  observedMaxMeanReturn: number | null;
  observedStatistic: number | null;
  pValue: number | null;
  checks: Array<{
    key: "candidate_family" | "minimum_sample" | "data_snooping_adjusted_superiority";
    state: "pass" | "fail" | "unknown";
    evidence: string;
  }>;
}

/**
 * White (2000) Reality Check against a zero-return cash benchmark.
 * Candidate return rows are aligned by date and resampled with identical block
 * indices so cross-candidate dependence is preserved.
 */
export function buildWhiteRealityCheck(
  candidates: RealityCheckCandidate[],
  options: { simulations?: number; alpha?: number } = {}
): WhiteRealityCheckReport {
  const unique = new Map<string, RealityCheckCandidate>();
  for (const candidate of candidates) {
    if (candidate.id.trim() && !unique.has(candidate.id)) unique.set(candidate.id, candidate);
  }
  const family = [...unique.values()];
  const simulations = Math.max(200, Math.min(5_000, Math.floor(options.simulations ?? 1_000)));
  const alpha = clamp(options.alpha ?? 0.05, 0.001, 0.2);
  const useBacktestBenchmark =
    family.length > 0 && family.every((candidate) => hasCompleteBenchmark(candidate.equityCurve));
  const aligned = alignCandidateReturns(family, useBacktestBenchmark);
  const sampleSize = aligned.dates.length;
  const blockSize = Math.max(1, Math.min(sampleSize || 1, Math.round(Math.sqrt(sampleSize || 1))));
  const seed = realityCheckSeed(family, aligned.dates, simulations);

  let bestCandidateId: string | null = null;
  let observedMaxMeanReturn: number | null = null;
  let observedStatistic: number | null = null;
  let pValue: number | null = null;
  if (family.length >= 2 && sampleSize >= 2) {
    const means = aligned.matrix.map(mean);
    const bestIndex = means.reduce(
      (best, value, index) => (value > (means[best] ?? Number.NEGATIVE_INFINITY) ? index : best),
      0
    );
    bestCandidateId = family[bestIndex]?.id ?? null;
    observedMaxMeanReturn = means[bestIndex] ?? null;
    observedStatistic = Math.sqrt(sampleSize) * (observedMaxMeanReturn ?? 0);

    const centered = aligned.matrix.map((series, index) =>
      series.map((value) => value - (means[index] ?? 0))
    );
    const random = seededRandom(seed);
    let exceedances = 0;
    for (let simulation = 0; simulation < simulations; simulation += 1) {
      const indices = blockBootstrapIndices(sampleSize, blockSize, random);
      let simulatedMaximum = Number.NEGATIVE_INFINITY;
      for (const series of centered) {
        const simulatedMean = mean(indices.map((index) => series[index] ?? 0));
        simulatedMaximum = Math.max(simulatedMaximum, Math.sqrt(sampleSize) * simulatedMean);
      }
      if (simulatedMaximum >= observedStatistic) exceedances += 1;
    }
    pValue = round((exceedances + 1) / (simulations + 1));
  }

  const checks: WhiteRealityCheckReport["checks"] = [
    {
      key: "candidate_family",
      state: family.length >= 2 ? "pass" : "unknown",
      evidence: `candidateCount=${family.length}; required=2`,
    },
    {
      key: "minimum_sample",
      state: sampleSize >= 60 ? "pass" : "unknown",
      evidence: `alignedReturnObservations=${sampleSize}; required=60`,
    },
    {
      key: "data_snooping_adjusted_superiority",
      state: pValue == null ? "unknown" : pValue <= alpha ? "pass" : "fail",
      evidence:
        pValue == null
          ? "Reality Check unavailable"
          : `best=${bestCandidateId}; maxMean=${round(observedMaxMeanReturn ?? 0)}; p=${pValue}; alpha=${alpha}`,
    },
  ];
  return {
    version: "white-reality-check-v1",
    status: checks.every((check) => check.state === "pass") ? "passed" : "research_only",
    benchmark: useBacktestBenchmark ? "backtest_benchmark" : "cash_zero_return",
    candidateCount: family.length,
    sampleSize,
    simulations,
    blockSize,
    seed,
    bestCandidateId,
    observedMaxMeanReturn:
      observedMaxMeanReturn == null ? null : round(observedMaxMeanReturn),
    observedStatistic: observedStatistic == null ? null : round(observedStatistic),
    pValue,
    checks,
  };
}

function alignCandidateReturns(
  candidates: RealityCheckCandidate[],
  useBacktestBenchmark: boolean
): {
  dates: string[];
  matrix: number[][];
} {
  const maps = candidates.map((candidate) =>
    equityReturnsByDate(candidate.equityCurve, useBacktestBenchmark)
  );
  const dates = maps.length
    ? [...maps[0]!.keys()].filter((date) => maps.every((map) => map.has(date))).sort()
    : [];
  return {
    dates,
    matrix: maps.map((map) => dates.map((date) => map.get(date) ?? 0)),
  };
}

function hasCompleteBenchmark(curve: BacktestEquityPoint[]): boolean {
  const sorted = [...curve].sort((left, right) => left.date.localeCompare(right.date));
  if (sorted.length < 2) return false;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous?.benchmarkEquity == null ||
      current?.benchmarkEquity == null ||
      previous.benchmarkEquity <= 0 ||
      !Number.isFinite(previous.benchmarkEquity) ||
      !Number.isFinite(current.benchmarkEquity)
    ) {
      return false;
    }
  }
  return true;
}

function equityReturnsByDate(
  curve: BacktestEquityPoint[],
  useBacktestBenchmark: boolean
): Map<string, number> {
  const sorted = [...curve].sort((left, right) => left.date.localeCompare(right.date));
  const returns = new Map<string, number>();
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]?.equity ?? 0;
    const current = sorted[index]?.equity ?? 0;
    if (previous <= 0 || !Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const strategyReturn = current / previous - 1;
    const benchmarkReturn = useBacktestBenchmark
      ? (sorted[index]!.benchmarkEquity ?? 0) /
          (sorted[index - 1]!.benchmarkEquity ?? 1) -
        1
      : 0;
    const value = strategyReturn - benchmarkReturn;
    if (Number.isFinite(value)) returns.set(sorted[index]!.date, value);
  }
  return returns;
}

function blockBootstrapIndices(length: number, blockSize: number, random: () => number): number[] {
  const indices: number[] = [];
  while (indices.length < length) {
    const start = Math.floor(random() * length);
    for (let offset = 0; offset < blockSize && indices.length < length; offset += 1) {
      indices.push((start + offset) % length);
    }
  }
  return indices;
}

function realityCheckSeed(
  candidates: RealityCheckCandidate[],
  dates: string[],
  simulations: number
): number {
  return createHash("sha256")
    .update(
      JSON.stringify({
        candidates: candidates.map((candidate) => candidate.id),
        dates,
        simulations,
      })
    )
    .digest()
    .readUInt32LE(0);
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number): number {
  return Number(value.toFixed(8));
}
