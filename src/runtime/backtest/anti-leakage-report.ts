import { createHash } from "node:crypto";
import type { BacktestRequest } from "../provider/types";

export type IntegrityCheckState = "pass" | "fail" | "unknown" | "not_applicable";

export interface BacktestIntegrityCheck {
  key:
    | "immutable_dataset"
    | "runtime_data_isolation"
    | "signal_fill_separation"
    | "point_in_time"
    | "survivorship_bias"
    | "corporate_actions"
    | "restatement_bias"
    | "parameter_selection"
    | "oos_isolation"
    | "embargo_isolation"
    | "transaction_costs";
  state: IntegrityCheckState;
  evidence: string;
  requiredForValidation: boolean;
}

export interface BacktestIntegrityReport {
  version: "anti-leakage-v2";
  status: "passed" | "research_only" | "rejected";
  inputFingerprint: string;
  datasetSnapshotId: string;
  checks: BacktestIntegrityCheck[];
  failedChecks: string[];
  unknownChecks: string[];
}

export interface BacktestIntegrityContext {
  runtimeDataIsolated: boolean;
  nextBarExecution: boolean;
  oos?: {
    mode: "walk_forward" | "holdout";
    foldCount: number;
    purgeDays: number;
    embargoDays?: number;
  };
}

/** Evidence absence remains unknown; it is never silently promoted to pass. */
export function buildBacktestIntegrityReport(
  input: BacktestRequest,
  context: BacktestIntegrityContext
): BacktestIntegrityReport {
  const qualification = input.dataset.qualification;
  const experiment = input.experiment;
  const costsValid =
    Number.isFinite(input.costs.commissionBps) &&
    input.costs.commissionBps >= 0 &&
    Number.isFinite(input.costs.slippageBps) &&
    input.costs.slippageBps >= 0 &&
    (input.costs.minCommission === undefined ||
      (Number.isFinite(input.costs.minCommission) && input.costs.minCommission >= 0));
  const frictionEvidence = input.costs.commissionBps > 0 || input.costs.slippageBps > 0;
  const shortCostEvidence =
    !input.longShort ||
    ((input.costs.borrowRateAnnualBps ?? 0) > 0 &&
      Array.isArray(input.costs.restrictedShortSymbols));
  const costModelProvenance =
    Boolean(input.costs.costModelVersion?.trim()) &&
    Boolean(input.costs.costModelSource?.trim()) &&
    input.costs.costModelSource !== "unverified_default_assumption" &&
    isIsoDateTime(input.costs.costModelAsOf);
  const checks: BacktestIntegrityCheck[] = [
    check(
      "immutable_dataset",
      input.dataset.snapshotId && input.dataset.dataRef ? "pass" : "fail",
      `snapshot=${input.dataset.snapshotId || "missing"}; dataRef=${input.dataset.dataRef || "missing"}`
    ),
    check(
      "runtime_data_isolation",
      context.runtimeDataIsolated ? "pass" : "fail",
      context.runtimeDataIsolated
        ? "provider consumed BacktestRequest.dataset only"
        : "provider runtime isolation was not established"
    ),
    check(
      "signal_fill_separation",
      context.nextBarExecution ? "pass" : "fail",
      context.nextBarExecution ? "signal[t] -> next eligible bar open" : "same-bar fill possible"
    ),
    check(
      "point_in_time",
      qualification.pointInTime === "verified" ? "pass" : "unknown",
      `dataset qualification pointInTime=${qualification.pointInTime}`
    ),
    check(
      "survivorship_bias",
      qualification.universeHistory === "verified" ? "pass" : "unknown",
      `universeHistory=${qualification.universeHistory}; ref=${qualification.universeHistoryRef ? `${qualification.universeHistoryRef.universeId}@${qualification.universeHistoryRef.version}:${qualification.universeHistoryRef.source}:${qualification.universeHistoryRef.asOf}` : "unregistered"}`
    ),
    check(
      "corporate_actions",
      qualification.corporateActions === "verified" ? "pass" : "unknown",
      `corporateActions=${qualification.corporateActions}; ref=${qualification.corporateActionLedgerRef ? `${qualification.corporateActionLedgerRef.version}:${qualification.corporateActionLedgerRef.source}:${qualification.corporateActionLedgerRef.asOf}` : "unregistered"}`
    ),
    check(
      "restatement_bias",
      "not_applicable",
      "current event-driven qlib_expr path consumes OHLCV only"
    ),
    check(
      "parameter_selection",
      experiment?.parameterSelection === "fixed_before_run"
        ? "pass"
        : experiment?.parameterSelection === "full_sample_optimized"
          ? "fail"
          : "unknown",
      experiment?.parameterSelection === "fixed_before_run"
        ? `parameters frozen before run${experiment.preRegistrationId ? `; registration=${experiment.preRegistrationId}` : ""}`
        : experiment?.parameterSelection === "full_sample_optimized"
          ? "parameters selected using the evaluation window"
          : "parameter-selection procedure was not registered"
    ),
    check(
      "oos_isolation",
      context.oos
        ? (context.oos.mode === "holdout"
            ? context.oos.foldCount === 1
            : context.oos.foldCount >= 2) && context.oos.purgeDays > 0
          ? "pass"
          : "fail"
        : "unknown",
      context.oos
        ? `${context.oos.mode}; folds=${context.oos.foldCount}; purgeDays=${context.oos.purgeDays}`
        : "single full-window backtest; no independent OOS evidence"
    ),
    check(
      "embargo_isolation",
      context.oos ? ((context.oos.embargoDays ?? 0) > 0 ? "pass" : "unknown") : "unknown",
      context.oos
        ? `no-observation buffer before each OOS fold; embargoDays=${context.oos.embargoDays ?? "unregistered"}`
        : "single full-window backtest; embargo evidence unavailable"
    ),
    check(
      "transaction_costs",
      !costsValid
        ? "fail"
        : frictionEvidence && shortCostEvidence && costModelProvenance
          ? "pass"
          : "unknown",
      `commissionBps=${input.costs.commissionBps}; slippageBps=${input.costs.slippageBps}; minCommission=${input.costs.minCommission ?? 0}; slippageModel=${input.costs.slippageModel ?? "fixed_bps"}; longShort=${input.longShort ?? false}; borrowRateAnnualBps=${input.costs.borrowRateAnnualBps ?? "unregistered"}; costModelVersion=${input.costs.costModelVersion ?? "unregistered"}; costModelSource=${input.costs.costModelSource ?? "unregistered"}; costModelAsOf=${input.costs.costModelAsOf ?? "unregistered"}`
    ),
  ];
  const failedChecks = checks.filter((item) => item.state === "fail").map((item) => item.key);
  const unknownChecks = checks
    .filter((item) => item.requiredForValidation && item.state === "unknown")
    .map((item) => item.key);
  return {
    version: "anti-leakage-v2",
    status:
      failedChecks.length > 0 ? "rejected" : unknownChecks.length > 0 ? "research_only" : "passed",
    inputFingerprint: fingerprint(input),
    datasetSnapshotId: input.dataset.snapshotId,
    checks,
    failedChecks,
    unknownChecks,
  };
}

function isIsoDateTime(value: string | undefined): boolean {
  if (!value || Number.isNaN(Date.parse(value))) return false;
  return /^\d{4}-\d{2}-\d{2}T/.test(value);
}

function check(
  key: BacktestIntegrityCheck["key"],
  state: IntegrityCheckState,
  evidence: string
): BacktestIntegrityCheck {
  return { key, state, evidence, requiredForValidation: true };
}

function fingerprint(input: BacktestRequest): string {
  const canonical = JSON.stringify({
    strategyVersionId: input.strategyVersionId ?? null,
    datasetSnapshotId: input.dataset.snapshotId,
    dataRef: input.dataset.dataRef,
    sourceIds: [...input.dataset.sourceIds].sort(),
    signals: input.signals,
    universe: input.universe,
    symbols: [...input.symbols].sort(),
    startDate: input.startDate,
    endDate: input.endDate,
    capital: input.capital,
    costs: input.costs,
    rebalance: input.rebalance ?? "daily",
    topN: input.topN ?? null,
    longShort: input.longShort ?? false,
    benchmark: input.benchmark ?? null,
    experiment: input.experiment ?? null,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
