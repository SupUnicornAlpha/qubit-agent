import type { FactorComputeRow } from "../provider/types";

export type FactorCorrelationPair = {
  leftFactorId: string;
  rightFactorId: string;
  observations: number;
  correlation: number | null;
  status: "ok" | "insufficient_overlap" | "constant_series";
};

export type FactorCorrelationDiagnostics = {
  version: "factor-correlation-diagnostics-v1";
  status: "passed" | "failed" | "incomplete" | "not_applicable";
  maxAbsCorrelation: number;
  minimumObservations: number;
  pairs: FactorCorrelationPair[];
  highCorrelationPairs: FactorCorrelationPair[];
  missingFactorIds: string[];
  reasons: string[];
};

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length !== right.length || left.length < 2) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index]! - leftMean;
    const rightDelta = right[index]! - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  if (leftVariance <= Number.EPSILON || rightVariance <= Number.EPSILON) return null;
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

function valueMap(rows: FactorComputeRow[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const row of rows) {
    if (!finite(row.value)) continue;
    values.set(`${row.date}\u0000${row.symbol}`, row.value);
  }
  return values;
}

/**
 * Pairwise, same-observation factor correlation. This intentionally avoids
 * return correlation: it asks whether two factor signals add distinct cross-
 * sectional information on the frozen dataset. Callers decide whether the
 * result is a research warning or a promotion gate.
 */
export function diagnoseFactorCorrelation(input: {
  factorValues: Record<string, FactorComputeRow[]>;
  maxAbsCorrelation?: number;
  minimumObservations?: number;
}): FactorCorrelationDiagnostics {
  const factorIds = Object.keys(input.factorValues).sort();
  const maxAbsCorrelation = input.maxAbsCorrelation ?? 0.7;
  const minimumObservations = input.minimumObservations ?? 60;
  const missingFactorIds = factorIds.filter(
    (factorId) => valueMap(input.factorValues[factorId] ?? []).size === 0
  );
  const valuesByFactor = new Map(
    factorIds.map((factorId) => [factorId, valueMap(input.factorValues[factorId] ?? [])])
  );
  const pairs: FactorCorrelationPair[] = [];
  for (let leftIndex = 0; leftIndex < factorIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < factorIds.length; rightIndex += 1) {
      const leftFactorId = factorIds[leftIndex]!;
      const rightFactorId = factorIds[rightIndex]!;
      const leftValues = valuesByFactor.get(leftFactorId)!;
      const rightValues = valuesByFactor.get(rightFactorId)!;
      const left: number[] = [];
      const right: number[] = [];
      for (const [key, value] of leftValues) {
        const other = rightValues.get(key);
        if (other === undefined) continue;
        left.push(value);
        right.push(other);
      }
      if (left.length < minimumObservations) {
        pairs.push({
          leftFactorId,
          rightFactorId,
          observations: left.length,
          correlation: null,
          status: "insufficient_overlap",
        });
        continue;
      }
      const correlation = pearson(left, right);
      pairs.push({
        leftFactorId,
        rightFactorId,
        observations: left.length,
        correlation,
        status: correlation === null ? "constant_series" : "ok",
      });
    }
  }
  const highCorrelationPairs = pairs.filter(
    (pair) => pair.correlation !== null && Math.abs(pair.correlation) >= maxAbsCorrelation
  );
  const hasIncompletePair = pairs.some((pair) => pair.status !== "ok");
  const reasons = [
    ...(missingFactorIds.length ? ["factor_values_missing"] : []),
    ...(hasIncompletePair ? ["factor_pair_overlap_or_variance_insufficient"] : []),
    ...(highCorrelationPairs.length ? ["factor_pair_correlation_too_high"] : []),
  ];
  const status =
    factorIds.length < 2
      ? "not_applicable"
      : highCorrelationPairs.length
        ? "failed"
        : reasons.length
          ? "incomplete"
          : "passed";
  return {
    version: "factor-correlation-diagnostics-v1",
    status,
    maxAbsCorrelation,
    minimumObservations,
    pairs,
    highCorrelationPairs,
    missingFactorIds,
    reasons,
  };
}
