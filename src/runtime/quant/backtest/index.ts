/** Quant domain route for backtest jobs, integrity and statistical validation. */
export * as jobs from "../../backtest/backtest-job-service";
export * as dataset from "../../backtest/dataset-snapshot-binding";
export * as pit from "../../backtest/pit-verifier";
export * as antiLeakage from "../../backtest/anti-leakage-report";
export * as realityCheck from "../../backtest/reality-check";
export * as performanceMetrics from "../../backtest/performance-metrics";
export * as statisticalValidation from "../../backtest/statistical-validation-report";
export * as monteCarlo from "../../backtest/monte-carlo-service";
export * as sensitivity from "../../backtest/sensitivity-analysis-service";
export * as finalHoldout from "../../backtest/final-holdout-contract";
