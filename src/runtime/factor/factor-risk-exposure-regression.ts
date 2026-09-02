import type { MarketRiskExposureLedger } from "../market/contracts/market-event-v2";
import type { FactorComputeRow } from "../provider/types";

export type FactorRiskExposureRegressionRow = {
  exposure: string;
  observations: number;
  beta: number | null;
  rSquared: number | null;
  status: "ok" | "insufficient_observations" | "constant_exposure";
};

export type JointRiskExposureCoefficient = {
  exposure: string;
  meanBeta: number | null;
  neweyWestStdError: number | null;
  tStatistic: number | null;
  pValue: number | null;
  crossSections: number;
};

export type JointRiskExposureRegression = {
  /** Fama–MacBeth cross-sectional OLS; coefficient means use Newey–West HAC. */
  method: "fama_macbeth_cross_sectional_ols_hac_v1";
  status: "passed" | "incomplete" | "rank_deficient";
  minimumCrossSections: number;
  eligibleCrossSections: number;
  skippedCrossSections: Array<{ date: string; observations: number; reason: string }>;
  commonExposures: string[];
  omittedExposures: Array<{ exposure: string; reason: "missing_pit_coverage" }>;
  meanR2: number | null;
  hacLag: number | null;
  coefficients: JointRiskExposureCoefficient[];
  reasons: string[];
};

export type FactorRiskExposureRegression = {
  version: "factor-risk-exposure-regression-v2";
  factorId: string;
  riskModel: { version: string; source: string; model: string; asOf: string };
  minimumObservations: number;
  matchedObservations: number;
  coverageStatus: "passed" | "incomplete";
  /** Backward-compatible one-control views. Do not interpret them as neutralized exposures. */
  rows: FactorRiskExposureRegressionRow[];
  /** Joint, PIT-safe external-exposure diagnostic. It is research evidence, not a promotion gate. */
  joint: JointRiskExposureRegression;
  reasons: string[];
};

type MatchedObservation = {
  date: string;
  value: number;
  exposures: Record<string, number>;
};

type CrossSectionFit = { betas: number[]; rSquared: number };

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
  return (
    [...candidates].sort(
      (left, right) =>
        right.availableAt.localeCompare(left.availableAt) ||
        right.effectiveDate.localeCompare(left.effectiveDate) ||
        (right.revisionId ?? "").localeCompare(left.revisionId ?? "")
    )[0]?.exposures ?? null
  );
}

/** Independent one-control cross-sectional OLS; retained for stable callers. */
function regress(
  target: number[],
  control: number[]
): Pick<FactorRiskExposureRegressionRow, "beta" | "rSquared" | "status"> {
  const xMean = mean(control);
  const yMean = mean(target);
  let xx = 0;
  let xy = 0;
  let total = 0;
  for (let index = 0; index < target.length; index += 1) {
    const dx = (control[index] ?? 0) - xMean;
    const dy = (target[index] ?? 0) - yMean;
    xx += dx * dx;
    xy += dx * dy;
    total += dy * dy;
  }
  if (xx <= Number.EPSILON) return { beta: null, rSquared: null, status: "constant_exposure" };
  const beta = xy / xx;
  const intercept = yMean - beta * xMean;
  const residual = target.reduce(
    (sum, value, index) => sum + (value - (intercept + beta * (control[index] ?? 0))) ** 2,
    0
  );
  return {
    beta,
    rSquared: total <= Number.EPSILON ? 0 : Math.max(0, 1 - residual / total),
    status: "ok",
  };
}

/**
 * The joint result intentionally uses only dimensions available for every
 * point-in-time matched observation. It is preferable to silently dropping a
 * style/industry dimension and then calling the residual "neutral".
 */
function jointRegression(
  matched: MatchedObservation[],
  minimumObservations: number,
  minimumCrossSections: number
): JointRiskExposureRegression {
  const candidateExposures = [
    ...new Set(matched.flatMap((row) => Object.keys(row.exposures))),
  ].sort();
  const commonExposures = candidateExposures.filter((exposure) =>
    matched.every((row) => Number.isFinite(row.exposures[exposure]))
  );
  const omittedExposures = candidateExposures
    .filter((exposure) => !commonExposures.includes(exposure))
    .map((exposure) => ({ exposure, reason: "missing_pit_coverage" as const }));
  const base = {
    method: "fama_macbeth_cross_sectional_ols_hac_v1" as const,
    minimumCrossSections,
    commonExposures,
    omittedExposures,
  };
  if (matched.length < minimumObservations) {
    return {
      ...base,
      status: "incomplete",
      eligibleCrossSections: 0,
      skippedCrossSections: [],
      meanR2: null,
      hacLag: null,
      coefficients: [],
      reasons: ["risk_exposure_pit_coverage_insufficient"],
    };
  }
  if (commonExposures.length === 0) {
    return {
      ...base,
      status: "incomplete",
      eligibleCrossSections: 0,
      skippedCrossSections: [],
      meanR2: null,
      hacLag: null,
      coefficients: [],
      reasons: ["risk_exposure_common_dimensions_missing"],
    };
  }

  const byDate = new Map<string, MatchedObservation[]>();
  for (const item of matched) {
    const current = byDate.get(item.date) ?? [];
    current.push(item);
    byDate.set(item.date, current);
  }
  const requiredCrossSection = commonExposures.length + 2;
  const fits: Array<{ date: string; fit: CrossSectionFit }> = [];
  const skippedCrossSections: JointRiskExposureRegression["skippedCrossSections"] = [];
  for (const [date, rows] of [...byDate.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (rows.length < requiredCrossSection) {
      skippedCrossSections.push({
        date,
        observations: rows.length,
        reason: "cross_section_too_small",
      });
      continue;
    }
    const fit = fitCrossSection(rows, commonExposures);
    if (!fit) {
      skippedCrossSections.push({
        date,
        observations: rows.length,
        reason: "cross_section_rank_deficient",
      });
      continue;
    }
    fits.push({ date, fit });
  }
  const rankDeficient = skippedCrossSections.some(
    (item) => item.reason === "cross_section_rank_deficient"
  );
  if (fits.length < minimumCrossSections || rankDeficient || omittedExposures.length > 0) {
    const reasons = [
      ...(fits.length < minimumCrossSections ? ["risk_exposure_cross_sections_insufficient"] : []),
      ...(rankDeficient ? ["risk_exposure_cross_section_rank_deficient"] : []),
      ...(omittedExposures.length ? ["risk_exposure_dimensions_incomplete"] : []),
    ];
    return {
      ...base,
      status: rankDeficient ? "rank_deficient" : "incomplete",
      eligibleCrossSections: fits.length,
      skippedCrossSections,
      meanR2: fits.length ? round(mean(fits.map((item) => item.fit.rSquared))) : null,
      hacLag: fits.length > 1 ? neweyWestLag(fits.length) : null,
      coefficients: aggregateCoefficients(fits, commonExposures),
      reasons,
    };
  }
  return {
    ...base,
    status: "passed",
    eligibleCrossSections: fits.length,
    skippedCrossSections,
    meanR2: round(mean(fits.map((item) => item.fit.rSquared))),
    hacLag: neweyWestLag(fits.length),
    coefficients: aggregateCoefficients(fits, commonExposures),
    reasons: [],
  };
}

/** Fits y = alpha + X beta by a pivoted normal-equation solve. */
function fitCrossSection(rows: MatchedObservation[], exposures: string[]): CrossSectionFit | null {
  const width = exposures.length + 1;
  const normal = Array.from({ length: width }, () => Array<number>(width + 1).fill(0));
  for (const row of rows) {
    const vector = [1, ...exposures.map((exposure) => row.exposures[exposure] ?? 0)];
    for (let left = 0; left < width; left += 1) {
      const normalRow = normal[left];
      if (!normalRow) return null;
      const leftValue = vector[left] ?? 0;
      normalRow[width] = (normalRow[width] ?? 0) + leftValue * row.value;
      for (let right = 0; right < width; right += 1) {
        normalRow[right] = (normalRow[right] ?? 0) + leftValue * (vector[right] ?? 0);
      }
    }
  }
  const betas = solveLinearSystem(normal);
  if (!betas) return null;
  const yMean = mean(rows.map((row) => row.value));
  let total = 0;
  let residual = 0;
  for (const row of rows) {
    const predicted =
      (betas[0] ?? 0) +
      exposures.reduce(
        (sum, exposure, index) => sum + (betas[index + 1] ?? 0) * (row.exposures[exposure] ?? 0),
        0
      );
    total += (row.value - yMean) ** 2;
    residual += (row.value - predicted) ** 2;
  }
  return { betas, rSquared: total <= Number.EPSILON ? 0 : Math.max(0, 1 - residual / total) };
}

function solveLinearSystem(matrix: number[][]): number[] | null {
  const size = matrix.length;
  const work = matrix.map((row) => [...row]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(work[row]?.[column] ?? 0) > Math.abs(work[pivot]?.[column] ?? 0)) {
        pivot = row;
      }
    }
    const pivotValue = work[pivot]?.[column] ?? 0;
    if (!Number.isFinite(pivotValue) || Math.abs(pivotValue) <= 1e-10) return null;
    const pivotRow = work[pivot];
    const currentRow = work[column];
    if (!pivotRow || !currentRow) return null;
    [work[column], work[pivot]] = [pivotRow, currentRow];
    for (let row = column + 1; row < size; row += 1) {
      const targetRow = work[row];
      const sourceRow = work[column];
      if (!targetRow || !sourceRow) return null;
      const multiplier = (targetRow[column] ?? 0) / (sourceRow[column] ?? 0);
      for (let entry = column; entry <= size; entry += 1) {
        targetRow[entry] = (targetRow[entry] ?? 0) - multiplier * (sourceRow[entry] ?? 0);
      }
    }
  }
  const output = Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    const currentRow = work[row];
    if (!currentRow) return null;
    let value = currentRow[size] ?? 0;
    for (let column = row + 1; column < size; column += 1) {
      value -= (currentRow[column] ?? 0) * (output[column] ?? 0);
    }
    output[row] = value / (currentRow[row] ?? 0);
  }
  return output.every(Number.isFinite) ? output : null;
}

function aggregateCoefficients(
  fits: Array<{ date: string; fit: CrossSectionFit }>,
  exposures: string[]
): JointRiskExposureCoefficient[] {
  return exposures.map((exposure, index) => {
    const values = fits.map((item) => item.fit.betas[index + 1] ?? 0);
    const estimate = mean(values);
    const stdError = neweyWestMeanStdError(values);
    const tStatistic = stdError != null && stdError > Number.EPSILON ? estimate / stdError : null;
    return {
      exposure,
      meanBeta: round(estimate),
      neweyWestStdError: stdError == null ? null : round(stdError),
      tStatistic: tStatistic == null ? null : round(tStatistic),
      pValue: tStatistic == null ? null : round(2 * (1 - normalCdf(Math.abs(tStatistic)))),
      crossSections: values.length,
    };
  });
}

function neweyWestMeanStdError(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values);
  const centered = values.map((value) => value - average);
  const lag = neweyWestLag(values.length);
  let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / values.length;
  for (let offset = 1; offset <= lag; offset += 1) {
    let covariance = 0;
    for (let index = offset; index < centered.length; index += 1) {
      covariance += (centered[index] ?? 0) * (centered[index - offset] ?? 0);
    }
    covariance /= values.length;
    longRunVariance += 2 * (1 - offset / (lag + 1)) * covariance;
  }
  return Math.sqrt(Math.max(0, longRunVariance / values.length));
}

function neweyWestLag(length: number): number {
  return Math.max(0, Math.min(length - 1, Math.floor(4 * (length / 100) ** (2 / 9))));
}

function normalCdf(value: number): number {
  // Abramowitz-Stegun approximation; this is explicitly a large-sample normal
  // approximation, not an exact small-sample t distribution claim.
  const t = 1 / (1 + 0.2316419 * value);
  const density = Math.exp((-value * value) / 2) / Math.sqrt(2 * Math.PI);
  const polynomial =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return Math.min(1, Math.max(0, 1 - density * polynomial));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Number(value.toFixed(6));
}

export function regressFactorRiskExposures(input: {
  factorId: string;
  values: FactorComputeRow[];
  ledger: MarketRiskExposureLedger;
  minimumObservations?: number;
  minimumCrossSections?: number;
}): FactorRiskExposureRegression {
  const minimumObservations = input.minimumObservations ?? 60;
  const minimumCrossSections = input.minimumCrossSections ?? 20;
  if (!Number.isInteger(minimumObservations) || minimumObservations < 2) {
    throw new Error("risk_exposure_minimum_observations_invalid");
  }
  if (!Number.isInteger(minimumCrossSections) || minimumCrossSections < 2) {
    throw new Error("risk_exposure_minimum_cross_sections_invalid");
  }
  const matched: MatchedObservation[] = input.values.flatMap((row) => {
    if (!Number.isFinite(row.value)) return [];
    const exposures = latestExposure(input.ledger, row.symbol, row.date);
    return exposures ? [{ date: row.date, value: row.value ?? 0, exposures }] : [];
  });
  const keys = [...new Set(matched.flatMap((row) => Object.keys(row.exposures)))].sort();
  const rows = keys.map((exposure) => {
    const usable = matched.filter((row) => Number.isFinite(row.exposures[exposure]));
    if (usable.length < minimumObservations) {
      return {
        exposure,
        observations: usable.length,
        beta: null,
        rSquared: null,
        status: "insufficient_observations" as const,
      };
    }
    return {
      exposure,
      observations: usable.length,
      ...regress(
        usable.map((row) => row.value),
        usable.map((row) => row.exposures[exposure] ?? 0)
      ),
    };
  });
  const coverageStatus =
    matched.length >= minimumObservations && rows.length > 0 ? "passed" : "incomplete";
  const joint = jointRegression(matched, minimumObservations, minimumCrossSections);
  return {
    version: "factor-risk-exposure-regression-v2",
    factorId: input.factorId,
    riskModel: {
      version: input.ledger.version,
      source: input.ledger.source,
      model: input.ledger.model,
      asOf: input.ledger.asOf,
    },
    minimumObservations,
    matchedObservations: matched.length,
    coverageStatus,
    rows,
    joint,
    reasons: [
      ...(matched.length < minimumObservations ? ["risk_exposure_pit_coverage_insufficient"] : []),
      ...(rows.length === 0 ? ["risk_exposure_dimensions_missing"] : []),
      ...(rows.some((row) => row.status !== "ok") ? ["risk_exposure_regression_incomplete"] : []),
    ],
  };
}
