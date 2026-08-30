import type { FactorComputeRow } from "../provider/types";

export type FactorExposureRow = {
  factorId: string;
  controls: string[];
  observations: number;
  rSquared: number | null;
  vif: number | null;
  status: "ok" | "insufficient_overlap" | "singular_controls" | "constant_target";
};

export type FactorExposureDiagnostics = {
  version: "factor-exposure-diagnostics-v1";
  status: "passed" | "failed" | "incomplete" | "not_applicable";
  maximumVif: number;
  minimumObservations: number;
  rows: FactorExposureRow[];
  highVifFactorIds: string[];
  missingFactorIds: string[];
  reasons: string[];
};

function finite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function valuesByObservation(rows: FactorComputeRow[]): Map<string, number> {
  const values = new Map<string, number>();
  for (const row of rows) {
    if (finite(row.value)) values.set(`${row.date}\u0000${row.symbol}`, row.value);
  }
  return values;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Solve A*x=b with Gauss-Jordan elimination; null makes rank deficiency explicit. */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(augmented[pivot]![column]!) <= 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const pivotValue = augmented[column]![column]!;
    for (let index = column; index <= n; index += 1) {
      augmented[column]![index] = augmented[column]![index]! / pivotValue;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const multiple = augmented[row]![column]!;
      for (let index = column; index <= n; index += 1) {
        augmented[row]![index] = augmented[row]![index]! - multiple * augmented[column]![index]!;
      }
    }
  }
  return augmented.map((row) => row[n]!);
}

function olsRSquared(target: number[], controls: number[][]): {
  rSquared: number | null;
  status: FactorExposureRow["status"];
} {
  const targetMean = mean(target);
  const total = target.reduce((sum, value) => sum + (value - targetMean) ** 2, 0);
  if (total <= Number.EPSILON) return { rSquared: null, status: "constant_target" };
  const width = controls.length + 1;
  const xtx = Array.from({ length: width }, () => Array<number>(width).fill(0));
  const xty = Array<number>(width).fill(0);
  for (let row = 0; row < target.length; row += 1) {
    const x = [1, ...controls.map((control) => control[row]!)];
    for (let left = 0; left < width; left += 1) {
      xty[left] = xty[left]! + x[left]! * target[row]!;
      for (let right = 0; right < width; right += 1) {
        xtx[left]![right] = xtx[left]![right]! + x[left]! * x[right]!;
      }
    }
  }
  const coefficients = solve(xtx, xty);
  if (!coefficients) return { rSquared: null, status: "singular_controls" };
  const residual = target.reduce((sum, value, row) => {
    const fitted = coefficients[0]! + controls.reduce(
      (inner, control, column) => inner + coefficients[column + 1]! * control[row]!,
      0
    );
    return sum + (value - fitted) ** 2;
  }, 0);
  return { rSquared: Math.max(0, Math.min(1, 1 - residual / total)), status: "ok" };
}

/**
 * Reports each signal's linear exposure to the other signals at the identical
 * (date,symbol) observations of one frozen snapshot. It deliberately does not
 * label these as sector/style exposures: those require an external, versioned
 * classification ledger. VIF is a diagnostic, never standalone alpha proof.
 */
export function diagnoseFactorExposure(input: {
  factorValues: Record<string, FactorComputeRow[]>;
  maximumVif?: number;
  minimumObservations?: number;
}): FactorExposureDiagnostics {
  const factorIds = Object.keys(input.factorValues).sort();
  const maximumVif = input.maximumVif ?? 5;
  const minimumObservations = input.minimumObservations ?? 60;
  const values = new Map(
    factorIds.map((factorId) => [factorId, valuesByObservation(input.factorValues[factorId] ?? [])])
  );
  const missingFactorIds = factorIds.filter((factorId) => values.get(factorId)!.size === 0);
  const rows: FactorExposureRow[] = [];
  for (const factorId of factorIds) {
    const controls = factorIds.filter((id) => id !== factorId);
    const targetValues = values.get(factorId)!;
    const commonKeys = [...targetValues.keys()].filter((key) =>
      controls.every((controlId) => values.get(controlId)!.has(key))
    );
    if (commonKeys.length < minimumObservations) {
      rows.push({
        factorId,
        controls,
        observations: commonKeys.length,
        rSquared: null,
        vif: null,
        status: "insufficient_overlap",
      });
      continue;
    }
    const target = commonKeys.map((key) => targetValues.get(key)!);
    const controlValues = controls.map((controlId) =>
      commonKeys.map((key) => values.get(controlId)!.get(key)!)
    );
    const result = olsRSquared(target, controlValues);
    const vif =
      result.rSquared === null || result.rSquared >= 1 - 1e-12
        ? null
        : 1 / (1 - result.rSquared);
    rows.push({
      factorId,
      controls,
      observations: commonKeys.length,
      rSquared: result.rSquared,
      vif,
      status: result.status,
    });
  }
  const highVifFactorIds = rows
    .filter((row) => row.vif !== null && row.vif >= maximumVif)
    .map((row) => row.factorId);
  const hasIncomplete = rows.some((row) => row.status !== "ok");
  const reasons = [
    ...(missingFactorIds.length ? ["factor_values_missing"] : []),
    ...(hasIncomplete ? ["factor_exposure_overlap_or_rank_insufficient"] : []),
    ...(highVifFactorIds.length ? ["factor_vif_too_high"] : []),
  ];
  return {
    version: "factor-exposure-diagnostics-v1",
    status:
      factorIds.length < 2
        ? "not_applicable"
        : highVifFactorIds.length
          ? "failed"
          : reasons.length
            ? "incomplete"
            : "passed",
    maximumVif,
    minimumObservations,
    rows,
    highVifFactorIds,
    missingFactorIds,
    reasons,
  };
}
