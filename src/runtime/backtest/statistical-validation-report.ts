import { createHash } from "node:crypto";
import type { BacktestEquityPoint, BacktestRequest } from "../provider/types";

export interface BacktestStatisticalValidationReport {
  version: "statistical-validation-v3";
  status: "passed" | "research_only";
  sampleSize: number;
  candidateTrials: number | null;
  familyWiseAlpha: number;
  adjustedAlpha: number | null;
  simulations: number;
  blockSize: number;
  seed: number;
  periodsPerYear: number;
  observedSharpe: number;
  sharpeConfidenceInterval: { lower: number; upper: number } | null;
  probabilitySharpePositive: number | null;
  rawSharpePValue: number | null;
  bonferroniAdjustedPValue: number | null;
  deflatedSharpe: {
    probability: number;
    observedAnnualizedSharpe: number;
    benchmarkAnnualizedSharpe: number;
    trialMeanAnnualizedSharpe: number;
    trialStdAnnualizedSharpe: number;
    skewness: number;
    kurtosis: number;
    independentTrialCount: number;
    trialDistributionCount: number;
    assumptions: [
      "candidate_trials_treated_as_independent",
      "psr_moment_approximation_uses_iid_returns",
    ];
  } | null;
  checks: Array<{
    key:
      | "minimum_sample"
      | "trial_count_declared"
      | "sharpe_confidence"
      | "multiple_testing"
      | "deflated_sharpe";
    state: "pass" | "fail" | "unknown";
    evidence: string;
  }>;
}

export function buildStatisticalValidationReport(
  input: BacktestRequest,
  equityCurve: BacktestEquityPoint[],
  options: {
    simulations?: number;
    familyWiseAlpha?: number;
    trialAnnualizedSharpes?: number[];
    periodsPerYear?: number;
  } = {}
): BacktestStatisticalValidationReport {
  const returns = equityReturns(equityCurve);
  const sampleSize = returns.length;
  const candidateTrials = input.experiment?.candidateTrials ?? null;
  const familyWiseAlpha = clamp(options.familyWiseAlpha ?? 0.05, 0.001, 0.2);
  const adjustedAlpha = candidateTrials ? familyWiseAlpha / candidateTrials : null;
  const simulations = Math.max(200, Math.min(10_000, Math.floor(options.simulations ?? 2_000)));
  const periodsPerYear = Math.max(1, Math.floor(options.periodsPerYear ?? 252));
  const blockSize = Math.max(1, Math.min(sampleSize || 1, Math.round(Math.sqrt(sampleSize || 1))));
  const seed = seedFrom(input, sampleSize, candidateTrials, simulations);
  const observedSharpe = annualizedSharpe(returns, periodsPerYear);
  const deflatedSharpe = buildDeflatedSharpeEvidence(
    returns,
    observedSharpe,
    candidateTrials,
    options.trialAnnualizedSharpes,
    periodsPerYear
  );

  let sharpeConfidenceInterval: BacktestStatisticalValidationReport["sharpeConfidenceInterval"] =
    null;
  let probabilitySharpePositive: number | null = null;
  let rawSharpePValue: number | null = null;
  let bonferroniAdjustedPValue: number | null = null;
  if (sampleSize >= 2 && adjustedAlpha != null) {
    const random = seededRandom(seed);
    const bootstrapSharpes = Array.from({ length: simulations }, () =>
      annualizedSharpe(blockBootstrap(returns, blockSize, random), periodsPerYear)
    ).sort((a, b) => a - b);
    const tailAlpha = adjustedAlpha / 2;
    sharpeConfidenceInterval = {
      lower: round(quantile(bootstrapSharpes, tailAlpha)),
      upper: round(quantile(bootstrapSharpes, 1 - tailAlpha)),
    };
    probabilitySharpePositive = round(
      bootstrapSharpes.filter((value) => value > 0).length / bootstrapSharpes.length
    );
    rawSharpePValue = sharpeNullPValue(
      returns,
      blockSize,
      simulations,
      seededRandom(seed ^ 0x9e3779b9),
      periodsPerYear
    );
    bonferroniAdjustedPValue = round(
      Math.min(1, rawSharpePValue * Math.max(1, candidateTrials ?? 1))
    );
  }

  const checks: BacktestStatisticalValidationReport["checks"] = [
    {
      key: "minimum_sample",
      state: sampleSize >= 60 ? "pass" : "unknown",
      evidence: `returnObservations=${sampleSize}; required=60`,
    },
    {
      key: "trial_count_declared",
      state: candidateTrials != null ? "pass" : "unknown",
      evidence:
        candidateTrials != null
          ? `candidateTrials=${candidateTrials}; Bonferroni alpha=${round(adjustedAlpha ?? familyWiseAlpha)}`
          : "candidateTrials was not declared; multiple-testing correction unavailable",
    },
    {
      key: "sharpe_confidence",
      state:
        sharpeConfidenceInterval == null
          ? "unknown"
          : sharpeConfidenceInterval.lower > 0
            ? "pass"
            : "fail",
      evidence:
        sharpeConfidenceInterval == null
          ? "bootstrap confidence interval unavailable"
          : `observed=${round(observedSharpe)}; adjusted CI=[${sharpeConfidenceInterval.lower}, ${sharpeConfidenceInterval.upper}]; P(Sharpe>0)=${probabilitySharpePositive}`,
    },
    {
      key: "multiple_testing",
      state:
        bonferroniAdjustedPValue == null
          ? "unknown"
          : bonferroniAdjustedPValue <= familyWiseAlpha
            ? "pass"
            : "fail",
      evidence:
        bonferroniAdjustedPValue == null
          ? "null-bootstrap p-value unavailable"
          : `rawP=${rawSharpePValue}; Bonferroni adjustedP=${bonferroniAdjustedPValue}; alpha=${familyWiseAlpha}`,
    },
    {
      key: "deflated_sharpe",
      state:
        deflatedSharpe == null
          ? "unknown"
          : deflatedSharpe.probability >= 1 - familyWiseAlpha
            ? "pass"
            : "fail",
      evidence:
        deflatedSharpe == null
          ? "candidate Sharpe distribution unavailable for Deflated Sharpe Ratio"
          : `DSR=${deflatedSharpe.probability}; observed=${deflatedSharpe.observedAnnualizedSharpe}; selection benchmark=${deflatedSharpe.benchmarkAnnualizedSharpe}; skew=${deflatedSharpe.skewness}; kurtosis=${deflatedSharpe.kurtosis}`,
    },
  ];
  return {
    version: "statistical-validation-v3",
    status: checks.every((item) => item.state === "pass") ? "passed" : "research_only",
    sampleSize,
    candidateTrials,
    familyWiseAlpha,
    adjustedAlpha: adjustedAlpha == null ? null : round(adjustedAlpha),
    simulations,
    blockSize,
    seed,
    periodsPerYear,
    observedSharpe: round(observedSharpe),
    sharpeConfidenceInterval,
    probabilitySharpePositive,
    rawSharpePValue,
    bonferroniAdjustedPValue,
    deflatedSharpe,
    checks,
  };
}

function buildDeflatedSharpeEvidence(
  returns: number[],
  observedAnnualizedSharpe: number,
  candidateTrials: number | null,
  trialAnnualizedSharpes: number[] | undefined,
  periodsPerYear: number
): BacktestStatisticalValidationReport["deflatedSharpe"] {
  if (returns.length < 60 || candidateTrials == null) return null;
  const trials = (trialAnnualizedSharpes ?? []).filter(Number.isFinite);
  if (candidateTrials > 1 && trials.length < candidateTrials) return null;
  const trialMeanAnnualizedSharpe = candidateTrials === 1 ? 0 : mean(trials);
  const trialStdAnnualizedSharpe =
    candidateTrials === 1 ? 0 : sampleDeviation(trials, trialMeanAnnualizedSharpe);
  const expectedMaximumZ =
    candidateTrials === 1 ? 0 : expectedMaximumStandardNormal(candidateTrials);
  const benchmarkAnnualizedSharpe =
    trialMeanAnnualizedSharpe + trialStdAnnualizedSharpe * expectedMaximumZ;
  const observedPerPeriod = observedAnnualizedSharpe / Math.sqrt(periodsPerYear);
  const benchmarkPerPeriod = benchmarkAnnualizedSharpe / Math.sqrt(periodsPerYear);
  const moments = standardizedMoments(returns);
  if (!moments) return null;
  const denominatorSquared =
    1 -
    moments.skewness * observedPerPeriod +
    ((moments.kurtosis - 1) / 4) * observedPerPeriod ** 2;
  if (!Number.isFinite(denominatorSquared) || denominatorSquared <= 0) return null;
  const statistic =
    ((observedPerPeriod - benchmarkPerPeriod) * Math.sqrt(returns.length - 1)) /
    Math.sqrt(denominatorSquared);
  const probability = normalCdf(statistic);
  return {
    probability: round(probability),
    observedAnnualizedSharpe: round(observedAnnualizedSharpe),
    benchmarkAnnualizedSharpe: round(benchmarkAnnualizedSharpe),
    trialMeanAnnualizedSharpe: round(trialMeanAnnualizedSharpe),
    trialStdAnnualizedSharpe: round(trialStdAnnualizedSharpe),
    skewness: round(moments.skewness),
    kurtosis: round(moments.kurtosis),
    independentTrialCount: candidateTrials,
    trialDistributionCount: candidateTrials === 1 ? 1 : trials.length,
    assumptions: [
      "candidate_trials_treated_as_independent",
      "psr_moment_approximation_uses_iid_returns",
    ],
  };
}

function expectedMaximumStandardNormal(trials: number): number {
  const gamma = 0.5772156649015329;
  return (
    (1 - gamma) * inverseNormalCdf(1 - 1 / trials) +
    gamma * inverseNormalCdf(1 - 1 / (trials * Math.E))
  );
}

function standardizedMoments(values: number[]): { skewness: number; kurtosis: number } | null {
  if (values.length < 3) return null;
  const average = mean(values);
  const centered = values.map((value) => value - average);
  const second = mean(centered.map((value) => value ** 2));
  if (!Number.isFinite(second) || second <= 1e-24) return null;
  const third = mean(centered.map((value) => value ** 3));
  const fourth = mean(centered.map((value) => value ** 4));
  return {
    skewness: third / second ** 1.5,
    kurtosis: fourth / second ** 2,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function sampleDeviation(values: number[], average: number): number {
  if (values.length < 2) return 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  );
}

/** Acklam inverse-normal approximation; sufficient for audit thresholds. */
function inverseNormalCdf(probability: number): number {
  const p = clamp(probability, 1e-12, 1 - 1e-12);
  const a = [
    -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472,
    2.50662827745924,
  ];
  const b = [
    -54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857,
  ];
  const c = [
    -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373,
    4.37466414146497, 2.93816398269878,
  ];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    const numerator = ((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!;
    const denominator = (((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1;
    return numerator / denominator;
  }
  if (p > 1 - low) return -inverseNormalCdf(1 - p);
  const q = p - 0.5;
  const r = q * q;
  const numerator = (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q;
  const denominator = ((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1;
  return numerator / denominator;
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return clamp(0.5 * (1 + sign * erf), 0, 1);
}

export interface FalseDiscoveryRateResult {
  method: "benjamini_hochberg";
  alpha: number;
  hypothesisCount: number;
  discoveryCount: number;
  hypotheses: Array<{
    id: string;
    pValue: number | null;
    adjustedPValue: number | null;
    pass: boolean;
  }>;
}

/** Benjamini-Hochberg adjusted p-values; missing evidence never becomes a discovery. */
export function benjaminiHochberg(
  hypotheses: Array<{ id: string; pValue: number | null }>,
  alpha = 0.05
): FalseDiscoveryRateResult {
  const safeAlpha = clamp(alpha, 0.001, 0.2);
  const finite = hypotheses
    .map((item, originalIndex) => ({ ...item, originalIndex }))
    .filter(
      (item): item is { id: string; pValue: number; originalIndex: number } =>
        item.pValue !== null && Number.isFinite(item.pValue)
    )
    .map((item) => ({ ...item, pValue: clamp(item.pValue, 0, 1) }))
    .sort((left, right) => left.pValue - right.pValue);
  const adjustedByIndex = new Map<number, number>();
  let runningMinimum = 1;
  for (let index = finite.length - 1; index >= 0; index -= 1) {
    const item = finite[index]!;
    runningMinimum = Math.min(
      runningMinimum,
      (item.pValue * Math.max(1, hypotheses.length)) / (index + 1)
    );
    adjustedByIndex.set(item.originalIndex, round(Math.min(1, runningMinimum)));
  }
  const output = hypotheses.map((item, index) => {
    const adjustedPValue = adjustedByIndex.get(index) ?? null;
    return {
      id: item.id,
      pValue: item.pValue == null ? null : round(clamp(item.pValue, 0, 1)),
      adjustedPValue,
      pass: adjustedPValue != null && adjustedPValue <= safeAlpha,
    };
  });
  return {
    method: "benjamini_hochberg",
    alpha: safeAlpha,
    hypothesisCount: hypotheses.length,
    discoveryCount: output.filter((item) => item.pass).length,
    hypotheses: output,
  };
}

export function estimateSharpeNullPValue(
  equityCurve: BacktestEquityPoint[],
  options: { simulations?: number; seedKey?: string; periodsPerYear?: number } = {}
): number | null {
  const returns = equityReturns(equityCurve);
  if (returns.length < 20) return null;
  const simulations = Math.max(200, Math.min(5_000, Math.floor(options.simulations ?? 500)));
  const seed = createHash("sha256")
    .update(`${options.seedKey ?? "sharpe-null"}:${returns.length}:${simulations}`)
    .digest()
    .readUInt32LE(0);
  return sharpeNullPValue(
    returns,
    Math.max(1, Math.round(Math.sqrt(returns.length))),
    simulations,
    seededRandom(seed),
    Math.max(1, Math.floor(options.periodsPerYear ?? 252))
  );
}

function sharpeNullPValue(
  returns: number[],
  blockSize: number,
  simulations: number,
  random: () => number,
  periodsPerYear: number
): number {
  const observed = annualizedSharpe(returns, periodsPerYear);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const centered = returns.map((value) => value - mean);
  let exceedances = 0;
  for (let index = 0; index < simulations; index += 1) {
    if (annualizedSharpe(blockBootstrap(centered, blockSize, random), periodsPerYear) >= observed) {
      exceedances += 1;
    }
  }
  return round((exceedances + 1) / (simulations + 1));
}

function equityReturns(curve: BacktestEquityPoint[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1]?.equity ?? 0;
    const current = curve[index]?.equity ?? 0;
    if (previous <= 0 || !Number.isFinite(previous) || !Number.isFinite(current)) continue;
    const value = current / previous - 1;
    if (Number.isFinite(value)) out.push(value);
  }
  return out;
}

function annualizedSharpe(values: number[], periodsPerYear: number): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const deviation = Math.sqrt(Math.max(0, variance));
  return deviation > 1e-12 ? (mean / deviation) * Math.sqrt(periodsPerYear) : 0;
}

function blockBootstrap(values: number[], blockSize: number, random: () => number): number[] {
  const out: number[] = [];
  while (out.length < values.length) {
    const start = Math.floor(random() * values.length);
    for (let offset = 0; offset < blockSize && out.length < values.length; offset += 1) {
      out.push(values[(start + offset) % values.length]!);
    }
  }
  return out;
}

function quantile(sorted: number[], probability: number): number {
  if (sorted.length === 0) return 0;
  const position = clamp(probability, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}

function seedFrom(
  input: BacktestRequest,
  sampleSize: number,
  candidateTrials: number | null,
  simulations: number
): number {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        snapshotId: input.dataset.snapshotId,
        strategyVersionId: input.strategyVersionId ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        sampleSize,
        candidateTrials,
        simulations,
      })
    )
    .digest();
  return digest.readUInt32LE(0);
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
  return Number(value.toFixed(6));
}
