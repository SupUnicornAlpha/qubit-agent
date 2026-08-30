import type { MarketRiskExposureLedger } from "../market/contracts/market-event-v2";
import type { FactorComputeRow } from "../provider/types";

export type FactorRiskExposureRegressionRow = {
  exposure: string;
  observations: number;
  beta: number | null;
  rSquared: number | null;
  status: "ok" | "insufficient_observations" | "constant_exposure";
};

export type FactorRiskExposureRegression = {
  version: "factor-risk-exposure-regression-v1";
  factorId: string;
  riskModel: { version: string; source: string; model: string; asOf: string };
  minimumObservations: number;
  matchedObservations: number;
  coverageStatus: "passed" | "incomplete";
  rows: FactorRiskExposureRegressionRow[];
  reasons: string[];
};

function latestExposure(
  ledger: MarketRiskExposureLedger,
  symbol: string,
  decisionAt: string
): Record<string, number> | null {
  const date = decisionAt.slice(0, 10);
  const candidates = (ledger.observationsBySymbol[symbol.trim().toUpperCase()] ?? []).filter(
    (row) => row.effectiveDate <= date && row.availableAt <= decisionAt
  );
  if (!candidates.length) return null;
  return [...candidates].sort(
    (left, right) =>
      right.availableAt.localeCompare(left.availableAt) ||
      right.effectiveDate.localeCompare(left.effectiveDate) ||
      (right.revisionId ?? "").localeCompare(left.revisionId ?? "")
  )[0]!.exposures;
}

/** Independent one-control cross-sectional OLS; avoids claiming residual neutrality. */
function regress(target: number[], control: number[]): Pick<FactorRiskExposureRegressionRow, "beta" | "rSquared" | "status"> {
  const xMean = control.reduce((sum, value) => sum + value, 0) / control.length;
  const yMean = target.reduce((sum, value) => sum + value, 0) / target.length;
  let xx = 0;
  let xy = 0;
  let total = 0;
  for (let index = 0; index < target.length; index += 1) {
    const dx = control[index]! - xMean;
    const dy = target[index]! - yMean;
    xx += dx * dx;
    xy += dx * dy;
    total += dy * dy;
  }
  if (xx <= Number.EPSILON) return { beta: null, rSquared: null, status: "constant_exposure" };
  const beta = xy / xx;
  const intercept = yMean - beta * xMean;
  const residual = target.reduce(
    (sum, value, index) => sum + (value - (intercept + beta * control[index]!)) ** 2,
    0
  );
  return { beta, rSquared: total <= Number.EPSILON ? 0 : Math.max(0, 1 - residual / total), status: "ok" };
}

export function regressFactorRiskExposures(input: {
  factorId: string;
  values: FactorComputeRow[];
  ledger: MarketRiskExposureLedger;
  minimumObservations?: number;
}): FactorRiskExposureRegression {
  const minimumObservations = input.minimumObservations ?? 60;
  const matched = input.values.flatMap((row) => {
    if (!Number.isFinite(row.value)) return [];
    const exposures = latestExposure(input.ledger, row.symbol, row.date);
    return exposures ? [{ value: row.value!, exposures }] : [];
  });
  const keys = [...new Set(matched.flatMap((row) => Object.keys(row.exposures)))].sort();
  const rows = keys.map((exposure) => {
    const usable = matched.filter((row) => Number.isFinite(row.exposures[exposure]));
    if (usable.length < minimumObservations) {
      return { exposure, observations: usable.length, beta: null, rSquared: null, status: "insufficient_observations" as const };
    }
    return { exposure, observations: usable.length, ...regress(usable.map((row) => row.value), usable.map((row) => row.exposures[exposure]!)) };
  });
  const coverageStatus = matched.length >= minimumObservations && rows.length > 0 ? "passed" : "incomplete";
  return {
    version: "factor-risk-exposure-regression-v1",
    factorId: input.factorId,
    riskModel: { version: input.ledger.version, source: input.ledger.source, model: input.ledger.model, asOf: input.ledger.asOf },
    minimumObservations,
    matchedObservations: matched.length,
    coverageStatus,
    rows,
    reasons: [
      ...(matched.length < minimumObservations ? ["risk_exposure_pit_coverage_insufficient"] : []),
      ...(rows.length === 0 ? ["risk_exposure_dimensions_missing"] : []),
      ...(rows.some((row) => row.status !== "ok") ? ["risk_exposure_regression_incomplete"] : []),
    ],
  };
}
