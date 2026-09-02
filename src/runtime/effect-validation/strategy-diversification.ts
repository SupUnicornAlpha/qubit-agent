export type OosReturnPoint = {
  /** Frozen OOS bar timestamp/date; comparisons only pair identical keys. */
  timestamp: string;
  return: number;
};

export type StrategyDiversificationStatus =
  | "passed"
  | "insufficient_evidence"
  | "correlation_too_high"
  | "no_incremental_risk_adjusted_value";

export type StrategyDiversificationAssessment = {
  version: "strategy-diversification-v1";
  status: StrategyDiversificationStatus;
  pass: boolean;
  pairedObservations: number;
  correlation: number | null;
  championPeriodSharpe: number | null;
  challengerPeriodSharpe: number | null;
  equalWeightPeriodSharpe: number | null;
  incrementalPeriodSharpe: number | null;
  championVolatility: number | null;
  equalWeightVolatility: number | null;
  incrementalVolatility: number | null;
  reasons: string[];
};

export function equityCurveToOosReturns(
  points: Array<{ date: string; equity: number }>
): OosReturnPoint[] {
  const sorted = [...points]
    .filter(
      (point) =>
        typeof point.date === "string" &&
        point.date.trim() &&
        Number.isFinite(point.equity) &&
        point.equity > 0
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  const out: OosReturnPoint[] = [];
  let previous: number | null = null;
  for (const point of sorted) {
    if (previous != null) {
      const value = point.equity / previous - 1;
      if (Number.isFinite(value)) out.push({ timestamp: point.date, return: value });
    }
    previous = point.equity;
  }
  return out;
}

/**
 * Compares a candidate against the current champion only on identical frozen
 * OOS timestamps. It intentionally does not optimize weights: equal weights
 * make the portfolio increment auditable and prevent the comparison itself
 * from becoming another tuning surface.
 */
export function assessStrategyDiversification(input: {
  champion: OosReturnPoint[];
  challenger: OosReturnPoint[];
  minimumObservations?: number;
  maxAbsCorrelation?: number;
  minIncrementalPeriodSharpe?: number;
}): StrategyDiversificationAssessment {
  const minimumObservations = finiteInteger(input.minimumObservations, 60, 2);
  const maxAbsCorrelation = finiteRange(input.maxAbsCorrelation, 0.85, 0, 1);
  const minIncrementalPeriodSharpe = finiteNumber(input.minIncrementalPeriodSharpe, 0);
  const championByTime = returnMap(input.champion);
  const challengerByTime = returnMap(input.challenger);
  const timestamps = [...championByTime.keys()]
    .filter((timestamp) => challengerByTime.has(timestamp))
    .sort();
  if (timestamps.length < minimumObservations) {
    return insufficient(timestamps.length, "paired_oos_observations_insufficient");
  }
  const champion = timestamps.map((timestamp) => championByTime.get(timestamp) ?? 0);
  const challenger = timestamps.map((timestamp) => challengerByTime.get(timestamp) ?? 0);
  const correlation = pearson(champion, challenger);
  const championVolatility = sampleStd(champion);
  const challengerVolatility = sampleStd(challenger);
  if (
    correlation == null ||
    championVolatility == null ||
    challengerVolatility == null ||
    championVolatility === 0 ||
    challengerVolatility === 0
  ) {
    return insufficient(timestamps.length, "oos_return_variance_insufficient");
  }
  const combined = champion.map((value, index) => (value + (challenger[index] ?? 0)) / 2);
  const equalWeightVolatility = sampleStd(combined);
  const championPeriodSharpe = periodSharpe(champion);
  const challengerPeriodSharpe = periodSharpe(challenger);
  const equalWeightPeriodSharpe = periodSharpe(combined);
  if (
    equalWeightVolatility == null ||
    championPeriodSharpe == null ||
    challengerPeriodSharpe == null ||
    equalWeightPeriodSharpe == null
  ) {
    return insufficient(timestamps.length, "oos_portfolio_metric_unavailable");
  }
  const incrementalPeriodSharpe = equalWeightPeriodSharpe - championPeriodSharpe;
  const incrementalVolatility = equalWeightVolatility - championVolatility;
  if (Math.abs(correlation) > maxAbsCorrelation) {
    return assessment({
      status: "correlation_too_high",
      pairedObservations: timestamps.length,
      correlation,
      championPeriodSharpe,
      challengerPeriodSharpe,
      equalWeightPeriodSharpe,
      incrementalPeriodSharpe,
      championVolatility,
      equalWeightVolatility,
      incrementalVolatility,
      reasons: ["oos_return_correlation_too_high"],
    });
  }
  if (incrementalPeriodSharpe < minIncrementalPeriodSharpe) {
    return assessment({
      status: "no_incremental_risk_adjusted_value",
      pairedObservations: timestamps.length,
      correlation,
      championPeriodSharpe,
      challengerPeriodSharpe,
      equalWeightPeriodSharpe,
      incrementalPeriodSharpe,
      championVolatility,
      equalWeightVolatility,
      incrementalVolatility,
      reasons: ["equal_weight_portfolio_sharpe_not_improved"],
    });
  }
  return assessment({
    status: "passed",
    pairedObservations: timestamps.length,
    correlation,
    championPeriodSharpe,
    challengerPeriodSharpe,
    equalWeightPeriodSharpe,
    incrementalPeriodSharpe,
    championVolatility,
    equalWeightVolatility,
    incrementalVolatility,
    reasons: [],
  });
}

function returnMap(points: OosReturnPoint[]): Map<string, number> {
  const map = new Map<string, number>();
  const ambiguousTimestamps = new Set<string>();
  for (const point of points) {
    const timestamp = point.timestamp?.trim();
    if (!timestamp || !Number.isFinite(point.return)) continue;
    // A duplicated timestamp is ambiguous evidence, so discard that key rather
    // than accidentally selecting a last write from a mutable feed.
    if (map.has(timestamp) || ambiguousTimestamps.has(timestamp)) {
      map.delete(timestamp);
      ambiguousTimestamps.add(timestamp);
      continue;
    }
    map.set(timestamp, point.return);
  }
  return map;
}

function insufficient(
  pairedObservations: number,
  reason: string
): StrategyDiversificationAssessment {
  return assessment({
    status: "insufficient_evidence",
    pairedObservations,
    correlation: null,
    championPeriodSharpe: null,
    challengerPeriodSharpe: null,
    equalWeightPeriodSharpe: null,
    incrementalPeriodSharpe: null,
    championVolatility: null,
    equalWeightVolatility: null,
    incrementalVolatility: null,
    reasons: [reason],
  });
}

function assessment(
  input: Omit<StrategyDiversificationAssessment, "version" | "pass">
): StrategyDiversificationAssessment {
  return {
    version: "strategy-diversification-v1",
    ...input,
    pass: input.status === "passed",
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Number.isFinite(variance) && variance >= 0 ? Math.sqrt(variance) : null;
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let numerator = 0;
  let leftSum = 0;
  let rightSum = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = (left[index] ?? 0) - leftMean;
    const rightDelta = (right[index] ?? 0) - rightMean;
    numerator += leftDelta * rightDelta;
    leftSum += leftDelta ** 2;
    rightSum += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSum * rightSum);
  return denominator > 0 && Number.isFinite(denominator) ? numerator / denominator : null;
}

function periodSharpe(values: number[]): number | null {
  const volatility = sampleStd(values);
  if (volatility == null || volatility === 0) return null;
  return mean(values) / volatility;
}

function finiteInteger(value: number | undefined, fallback: number, min: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.floor(value as number)) : fallback;
}

function finiteRange(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}

function finiteNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}
