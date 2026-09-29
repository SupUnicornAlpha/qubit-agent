/**
 * Deterministic, offline prefix-invariance check on an already bound daily snapshot.
 * A pass covers only the sampled cutoffs and the existing expression evaluator. It
 * cannot establish historical data availability, universe correctness or OOS validity.
 */
import { materializeFundamentalPitFields } from "../backtest/fundamental-pit-series";
import { type PriceSeries, evalExpr } from "../provider/impls/factor/qlib-expr/evaluator";
import { tokenize } from "../provider/impls/factor/qlib-expr/lexer";
import { type Ast, parse } from "../provider/impls/factor/qlib-expr/parser";
import type { BacktestDataset, BacktestDatasetBar } from "../provider/types";

export type FactorTruncationStatus = "passed" | "failed" | "insufficient_data" | "unsupported";

export interface FactorTruncationMismatch {
  symbol: string;
  date: string;
  cutoff: string;
  fullValue: number | null;
  truncatedValue: number | null;
  kind: "value_changed" | "signal_availability_changed";
}

export interface FactorTruncationReport {
  checkVersion: "factor-truncation-v1";
  status: FactorTruncationStatus;
  datasetSnapshotId: string;
  cutoffs: string[];
  checkedSymbols: string[];
  comparedValues: number;
  uniqueComparedValues: number;
  skippedNullPairs: number;
  mismatchCount: number;
  /** Bounded examples; mismatchCount includes examples beyond this list. */
  mismatches: FactorTruncationMismatch[];
  issues: Array<{ code: string; message: string }>;
  absoluteTolerance: number;
  relativeTolerance: number;
  minComparisons: number;
  limitations: string[];
}

export interface FactorTruncationInput {
  expr: string;
  dataset: BacktestDataset;
  symbols?: string[];
  /** Inclusive session dates. At most three, and each must leave future rows. */
  cutoffs?: string[];
  absoluteTolerance?: number;
  relativeTolerance?: number;
  /** Minimum distinct finite symbol/date pairs; repeated cutoffs do not inflate it. */
  minComparisons?: number;
}

const MAX_BARS = 200_000;
const MAX_WORK = 30_000_000;
const MAX_EXAMPLES = 20;
const ROLLING = new Set(["Mean", "Std", "Sum", "Min", "Max", "Rank", "Corr", "Slope"]);

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Also usable to audit stored full/prefix outputs, without rerunning an evaluator. */
export function compareFactorSignalPrefixes(input: {
  symbol: string;
  cutoff: string;
  dates: string[];
  fullValues: Array<number | null>;
  truncatedValues: Array<number | null>;
  absoluteTolerance?: number;
  relativeTolerance?: number;
}): {
  comparedDates: string[];
  skippedNullPairs: number;
  mismatchCount: number;
  mismatches: FactorTruncationMismatch[];
} {
  const absoluteTolerance = input.absoluteTolerance ?? 1e-10;
  const relativeTolerance = input.relativeTolerance ?? 1e-8;
  const comparedDates: string[] = [];
  let skippedNullPairs = 0;
  let mismatchCount = 0;
  const mismatches: FactorTruncationMismatch[] = [];
  for (const [index, date] of input.dates.entries()) {
    if (date > input.cutoff) continue;
    const full = input.fullValues[index];
    const truncated = input.truncatedValues[index];
    if (!finite(full) && !finite(truncated)) {
      skippedNullPairs++;
      continue;
    }
    const bothFinite = finite(full) && finite(truncated);
    if (bothFinite) comparedDates.push(date);
    const equal =
      bothFinite &&
      Math.abs(full - truncated) <=
        absoluteTolerance + relativeTolerance * Math.max(Math.abs(full), Math.abs(truncated));
    if (equal) continue;
    mismatchCount++;
    if (mismatches.length < MAX_EXAMPLES) {
      mismatches.push({
        symbol: input.symbol,
        date,
        cutoff: input.cutoff,
        fullValue: finite(full) ? full : null,
        truncatedValue: finite(truncated) ? truncated : null,
        kind: bothFinite ? "value_changed" : "signal_availability_changed",
      });
    }
  }
  return { comparedDates, skippedNullPairs, mismatchCount, mismatches };
}

export function checkFactorTruncation(input: FactorTruncationInput): FactorTruncationReport {
  const report: FactorTruncationReport = {
    checkVersion: "factor-truncation-v1",
    status: "insufficient_data",
    datasetSnapshotId: input.dataset.snapshotId,
    cutoffs: [],
    checkedSymbols: [],
    comparedValues: 0,
    uniqueComparedValues: 0,
    skippedNullPairs: 0,
    mismatchCount: 0,
    mismatches: [],
    issues: [],
    absoluteTolerance: input.absoluteTolerance ?? 1e-10,
    relativeTolerance: input.relativeTolerance ?? 1e-8,
    minComparisons: input.minComparisons ?? 10,
    limitations: [
      "sampled_truncation_consistency_is_not_proof_of_no_lookahead",
      "does_not_verify_source_publication_times_or_revised_prices",
      "does_not_verify_historical_universe_or_independent_validation",
      "daily_qlib_expr_only",
    ],
  };
  const stop = (status: FactorTruncationStatus, code: string, message: string) => {
    report.status = status;
    report.issues.push({ code, message });
    return report;
  };
  if (!input.dataset.snapshotId?.trim()) {
    return stop("failed", "dataset_snapshot_required", "A bound immutable snapshot is required.");
  }
  if (input.dataset.timeframe !== "1d") {
    return stop("unsupported", "daily_data_required", "Only daily (1d) snapshots are supported.");
  }
  if (
    !finite(report.absoluteTolerance) ||
    report.absoluteTolerance < 0 ||
    !finite(report.relativeTolerance) ||
    report.relativeTolerance < 0 ||
    !Number.isInteger(report.minComparisons) ||
    report.minComparisons < 1
  ) {
    return stop(
      "failed",
      "invalid_check_options",
      "Tolerances must be finite and nonnegative; minComparisons must be positive."
    );
  }
  if (input.expr.length > 8_192) {
    return stop(
      "unsupported",
      "expression_budget_exceeded",
      "Expression length exceeds 8192 characters."
    );
  }
  let ast: Ast;
  try {
    let depth = 0;
    for (const token of tokenize(input.expr)) {
      if (token.type === "lparen") depth++;
      if (token.type === "rparen") depth--;
      if (depth < 0) throw new Error("Unmatched closing parenthesis.");
    }
    if (depth !== 0) throw new Error("Unmatched opening parenthesis.");
    // Wrapping forces the legacy parser to consume all user tokens before ')'.
    ast = parse(`(${input.expr})`);
  } catch (error) {
    return stop("failed", "invalid_expression", (error as Error).message);
  }
  let nodes = 0;
  let workWeight = 0;
  const stack: Ast[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node) break;
    nodes++;
    workWeight++;
    if (nodes > 256) {
      return stop("unsupported", "expression_budget_exceeded", "Expression exceeds 256 AST nodes.");
    }
    if (node.type === "call") {
      const arg = node.args[node.name === "Corr" ? 2 : 1];
      const scalar = arg ? constantValue(arg) : null;
      if ((node.name === "Ref" || node.name === "Delta") && scalar !== null && scalar < 0) {
        return stop("failed", "future_reference", `${node.name} uses a negative lag (${scalar}).`);
      }
      if (ROLLING.has(node.name) && scalar !== null && scalar > 0) {
        workWeight += Math.min(scalar, MAX_BARS) * (node.name === "Corr" ? 3 : 2);
      }
      stack.push(...node.args);
    } else if (node.type === "binop") stack.push(node.left, node.right);
    else if (node.type === "unary") stack.push(node.operand);
  }

  const symbols = [...new Set(input.symbols ?? Object.keys(input.dataset.barsBySymbol))].sort();
  if (!symbols.length) return stop("insufficient_data", "no_symbols", "No symbols were selected.");
  let totalBars = 0;
  const dateSet = new Set<string>();
  for (const symbol of symbols) {
    const bars = input.dataset.barsBySymbol[symbol];
    if (!bars?.length) {
      return stop("insufficient_data", "symbol_data_missing", `No snapshot bars for ${symbol}.`);
    }
    totalBars += bars.length;
    if (totalBars > MAX_BARS) {
      return stop(
        "unsupported",
        "computation_budget_exceeded",
        `Selected data exceeds ${MAX_BARS} bars.`
      );
    }
    let previous = "";
    for (const bar of bars) {
      const date = bar.timestamp.slice(0, 10);
      if (!validDate(date) || date <= previous) {
        return stop(
          "failed",
          "invalid_bar_order",
          `Expected one strictly ascending daily bar per date for ${symbol}.`
        );
      }
      previous = date;
      dateSet.add(date);
    }
  }
  const dates = [...dateSet].sort();
  const finalDate = dates.at(-1);
  if (dates.length < 2 || !finalDate) {
    return stop("insufficient_data", "no_future_rows", "At least two distinct dates are needed.");
  }
  const defaultCutoffs = [
    dates[Math.floor((dates.length - 1) / 2)],
    dates[Math.floor((dates.length - 1) * 0.75)],
    dates[dates.length - 2],
  ].filter((date): date is string => date !== undefined);
  const cutoffs = [...new Set(input.cutoffs ?? defaultCutoffs)].sort();
  if (
    !cutoffs.length ||
    cutoffs.length > 3 ||
    cutoffs.some((date) => !validDate(date) || !dateSet.has(date) || date >= finalDate)
  ) {
    return stop(
      "failed",
      "invalid_cutoffs",
      "Choose one to three snapshot dates, excluding the final date."
    );
  }
  report.cutoffs = cutoffs;
  const observations = input.dataset.fundamentalObservations ?? [];
  if (observations.length > 100_000) {
    return stop(
      "unsupported",
      "computation_budget_exceeded",
      "Fundamental observation count exceeds 100000."
    );
  }
  const metrics = new Set(observations.map((entry) => entry.metric));
  if (
    metrics.size > 64 ||
    totalBars * (1 + cutoffs.length) * (workWeight + metrics.size) > MAX_WORK
  ) {
    return stop(
      "unsupported",
      "computation_budget_exceeded",
      "Estimated expression work exceeds the bounded check budget."
    );
  }
  const uniqueCompared = new Set<string>();
  const coveredCutoffs = new Set<string>();
  const coveredSymbols = new Set<string>();
  for (const symbol of symbols) {
    const bars = input.dataset.barsBySymbol[symbol] ?? [];
    const symbolObservations = observations.filter((entry) => entry.symbol === symbol);
    try {
      const fullValues = evalExpr(ast, priceSeries(bars, symbolObservations));
      report.checkedSymbols.push(symbol);
      for (const cutoff of cutoffs) {
        const prefix = bars.filter((bar) => bar.timestamp.slice(0, 10) <= cutoff);
        if (!prefix.length || prefix.length === bars.length) continue;
        const truncatedValues = evalExpr(
          ast,
          priceSeries(
            prefix,
            symbolObservations.filter((entry) => entry.availableAt.slice(0, 10) <= cutoff)
          )
        );
        const result = compareFactorSignalPrefixes({
          symbol,
          cutoff,
          dates: prefix.map((bar) => bar.timestamp.slice(0, 10)),
          fullValues,
          truncatedValues,
          absoluteTolerance: report.absoluteTolerance,
          relativeTolerance: report.relativeTolerance,
        });
        report.comparedValues += result.comparedDates.length;
        report.skippedNullPairs += result.skippedNullPairs;
        report.mismatchCount += result.mismatchCount;
        report.mismatches.push(
          ...result.mismatches.slice(0, MAX_EXAMPLES - report.mismatches.length)
        );
        for (const date of result.comparedDates) uniqueCompared.add(`${symbol}\0${date}`);
        if (result.comparedDates.length) {
          coveredCutoffs.add(cutoff);
          coveredSymbols.add(symbol);
        }
      }
    } catch (error) {
      return stop(
        "failed",
        "expression_evaluation_failed",
        `${symbol}: ${(error as Error).message}`
      );
    }
  }
  report.uniqueComparedValues = uniqueCompared.size;
  if (report.mismatchCount) {
    return stop(
      "failed",
      "truncation_changed_past_signals",
      "Adding future rows changed past signal values or availability."
    );
  }
  if (
    report.uniqueComparedValues < report.minComparisons ||
    coveredCutoffs.size !== cutoffs.length ||
    coveredSymbols.size !== symbols.length
  ) {
    return stop(
      "insufficient_data",
      "insufficient_finite_comparisons",
      "Not enough distinct finite signals, or a selected symbol/cutoff has no comparable signals."
    );
  }
  report.status = "passed";
  return report;
}

function priceSeries(
  bars: BacktestDatasetBar[],
  observations: NonNullable<BacktestDataset["fundamentalObservations"]>
): PriceSeries {
  return {
    length: bars.length,
    fields: {
      open: bars.map((bar) => bar.open),
      high: bars.map((bar) => bar.high),
      low: bars.map((bar) => bar.low),
      close: bars.map((bar) => bar.close),
      volume: bars.map((bar) => bar.volume),
      turnover: bars.map((bar) => bar.turnover),
      vwap: bars.map((bar) => (bar.volume > 0 ? bar.turnover / bar.volume : bar.close)),
      ...materializeFundamentalPitFields(bars, observations),
    },
  };
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

function constantValue(ast: Ast): number | null {
  if (ast.type === "num") return ast.value;
  if (ast.type === "unary") {
    const value = constantValue(ast.operand);
    return value === null ? null : -value;
  }
  if (ast.type === "binop") {
    const left = constantValue(ast.left);
    const right = constantValue(ast.right);
    if (left === null || right === null) return null;
    switch (ast.op) {
      case "+":
        return left + right;
      case "-":
        return left - right;
      case "*":
        return left * right;
      case "/":
        return left / right;
    }
  }
  return null;
}
