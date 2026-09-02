/**
 * Execution-quality acceptance contract.
 *
 * This is deliberately a pure, optional evaluator.  A contract records the
 * broker / asset-class / bar-frequency cohort it was calibrated for, then
 * assesses only TCA collected from the matching runtime.  It does not change
 * order routing, strategy parameters, promotion, or live eligibility: those
 * policy decisions need an explicit product gate after a calibrated cohort is
 * approved.
 */

export interface ExecutionQualityMetrics {
  orderCount: number;
  averageFillRatePct: number | null;
  averageImplementationShortfallPct: number | null;
  p95ImplementationShortfallPct: number | null;
  averageSubmitLatencyMs: number | null;
  p95TotalLatencyMs: number | null;
  rejectionRatePct: number;
}

export interface ExecutionQualityAcceptanceContract {
  schemaVersion: 1;
  /** Immutable label for the historical broker/asset/frequency calibration. */
  calibrationId: string;
  scope: {
    broker: string;
    assetClass: string;
    timeframe: string;
  };
  minOrderCount: number;
  thresholds: {
    minAverageFillRatePct?: number;
    maxAverageImplementationShortfallPct?: number;
    maxP95ImplementationShortfallPct?: number;
    maxAverageSubmitLatencyMs?: number;
    maxP95TotalLatencyMs?: number;
    maxRejectionRatePct?: number;
  };
}

export type ExecutionQualityAssessmentStatus =
  | "not_configured"
  | "invalid_contract"
  | "scope_mismatch"
  | "insufficient_sample"
  | "passed"
  | "failed";

export interface ExecutionQualityAssessment {
  status: ExecutionQualityAssessmentStatus;
  /** Null means that this evidence is informational and cannot be gate input. */
  pass: boolean | null;
  calibrationId: string | null;
  sampleSize: number;
  minimumSampleSize: number | null;
  breaches: string[];
  contract: ExecutionQualityAcceptanceContract | null;
}

export function assessExecutionQualityAgainstContract(input: {
  metrics: ExecutionQualityMetrics;
  contract: unknown;
  runtimeScope: { broker: string; assetClass: string; timeframe: string };
}): ExecutionQualityAssessment {
  if (input.contract == null) return notConfigured(input.metrics.orderCount);
  const parsed = parseExecutionQualityAcceptanceContract(input.contract);
  if (!parsed.ok) {
    return {
      status: "invalid_contract",
      pass: null,
      calibrationId: null,
      sampleSize: input.metrics.orderCount,
      minimumSampleSize: null,
      breaches: [parsed.error],
      contract: null,
    };
  }
  const contract = parsed.contract;
  if (!scopeMatches(contract.scope, input.runtimeScope)) {
    return {
      status: "scope_mismatch",
      pass: null,
      calibrationId: contract.calibrationId,
      sampleSize: input.metrics.orderCount,
      minimumSampleSize: contract.minOrderCount,
      breaches: ["calibration_scope_mismatch"],
      contract,
    };
  }
  if (input.metrics.orderCount < contract.minOrderCount) {
    return {
      status: "insufficient_sample",
      pass: null,
      calibrationId: contract.calibrationId,
      sampleSize: input.metrics.orderCount,
      minimumSampleSize: contract.minOrderCount,
      breaches: [],
      contract,
    };
  }

  const breaches = checkThresholds(input.metrics, contract.thresholds);
  return {
    status: breaches.length === 0 ? "passed" : "failed",
    pass: breaches.length === 0,
    calibrationId: contract.calibrationId,
    sampleSize: input.metrics.orderCount,
    minimumSampleSize: contract.minOrderCount,
    breaches,
    contract,
  };
}

export function parseExecutionQualityAcceptanceContract(
  raw: unknown
): { ok: true; contract: ExecutionQualityAcceptanceContract } | { ok: false; error: string } {
  if (!isRecord(raw) || raw.schemaVersion !== 1)
    return { ok: false, error: "schema_version_invalid" };
  if (!nonEmptyString(raw.calibrationId)) return { ok: false, error: "calibration_id_invalid" };
  if (!isRecord(raw.scope)) return { ok: false, error: "scope_invalid" };
  if (
    !nonEmptyString(raw.scope.broker) ||
    !nonEmptyString(raw.scope.assetClass) ||
    !nonEmptyString(raw.scope.timeframe)
  ) {
    return { ok: false, error: "scope_dimension_invalid" };
  }
  if (!positiveInteger(raw.minOrderCount)) return { ok: false, error: "min_order_count_invalid" };
  if (!isRecord(raw.thresholds)) return { ok: false, error: "thresholds_invalid" };
  const thresholdNames = [
    "minAverageFillRatePct",
    "maxAverageImplementationShortfallPct",
    "maxP95ImplementationShortfallPct",
    "maxAverageSubmitLatencyMs",
    "maxP95TotalLatencyMs",
    "maxRejectionRatePct",
  ] as const;
  const thresholds: ExecutionQualityAcceptanceContract["thresholds"] = {};
  for (const name of thresholdNames) {
    const value = raw.thresholds[name];
    if (value === undefined) continue;
    if (!nonNegativeFinite(value)) return { ok: false, error: `threshold_${name}_invalid` };
    thresholds[name] = value;
  }
  if (Object.keys(thresholds).length === 0) return { ok: false, error: "thresholds_empty" };
  return {
    ok: true,
    contract: {
      schemaVersion: 1,
      calibrationId: raw.calibrationId.trim(),
      scope: {
        broker: raw.scope.broker.trim(),
        assetClass: raw.scope.assetClass.trim(),
        timeframe: raw.scope.timeframe.trim(),
      },
      minOrderCount: raw.minOrderCount,
      thresholds,
    },
  };
}

function notConfigured(sampleSize: number): ExecutionQualityAssessment {
  return {
    status: "not_configured",
    pass: null,
    calibrationId: null,
    sampleSize,
    minimumSampleSize: null,
    breaches: [],
    contract: null,
  };
}

function checkThresholds(
  metrics: ExecutionQualityMetrics,
  thresholds: ExecutionQualityAcceptanceContract["thresholds"]
): string[] {
  const breaches: string[] = [];
  checkMinimum(
    breaches,
    "average_fill_rate",
    metrics.averageFillRatePct,
    thresholds.minAverageFillRatePct
  );
  checkMaximum(
    breaches,
    "average_implementation_shortfall",
    metrics.averageImplementationShortfallPct,
    thresholds.maxAverageImplementationShortfallPct
  );
  checkMaximum(
    breaches,
    "p95_implementation_shortfall",
    metrics.p95ImplementationShortfallPct,
    thresholds.maxP95ImplementationShortfallPct
  );
  checkMaximum(
    breaches,
    "average_submit_latency",
    metrics.averageSubmitLatencyMs,
    thresholds.maxAverageSubmitLatencyMs
  );
  checkMaximum(
    breaches,
    "p95_total_latency",
    metrics.p95TotalLatencyMs,
    thresholds.maxP95TotalLatencyMs
  );
  checkMaximum(
    breaches,
    "rejection_rate",
    metrics.rejectionRatePct,
    thresholds.maxRejectionRatePct
  );
  return breaches;
}

function checkMinimum(
  breaches: string[],
  name: string,
  value: number | null,
  min: number | undefined
) {
  if (min === undefined) return;
  if (value == null) breaches.push(`${name}_missing`);
  else if (value < min) breaches.push(`${name}_below_threshold`);
}

function checkMaximum(
  breaches: string[],
  name: string,
  value: number | null,
  max: number | undefined
) {
  if (max === undefined) return;
  if (value == null) breaches.push(`${name}_missing`);
  else if (value > max) breaches.push(`${name}_above_threshold`);
}

function scopeMatches(
  contract: ExecutionQualityAcceptanceContract["scope"],
  runtime: { broker: string; assetClass: string; timeframe: string }
) {
  return (
    scopeValueMatches(contract.broker, runtime.broker) &&
    scopeValueMatches(contract.assetClass, runtime.assetClass) &&
    scopeValueMatches(contract.timeframe, runtime.timeframe)
  );
}

function scopeValueMatches(expected: string, actual: string) {
  return expected === "*" || expected.trim().toLowerCase() === actual.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
