import type { BacktestMetrics } from "../provider/types";

export interface GenomeFitnessInput {
  metrics: Pick<
    BacktestMetrics,
    | "annualReturn"
    | "sharpe"
    | "sortino"
    | "calmar"
    | "maxDrawdown"
    | "conditionalValueAtRisk95"
    | "turnover"
    | "positivePeriodRate"
    | "maxConsecutiveLosses"
    | "tradeCount"
    | "benchmark"
  >;
  sampleSize: number;
}

export interface GenomeFitnessResult {
  /** 0–100；仅通过硬性准入时才会被写入 fitness_score、参与进化。 */
  score: number;
  eligible: boolean;
  dimensions: Record<
    "return" | "riskAdjusted" | "risk" | "stability" | "benchmark" | "capacity",
    number
  >;
  failedGates: string[];
  missingMetrics: string[];
  gateVersion: "genome-fitness-v1";
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const scoreRange = (value: number | null, low: number, high: number) =>
  value == null ? 0 : clamp01((value - low) / (high - low));

/**
 * 多目标适应度：收益不是唯一目标，回撤尾部、跨期稳定性、基准相对表现和换手成本共同决定。
 *
 * 这个函数刻意不从 totalReturn 推导年化，调用方必须提交由统一绩效模块计算的 metrics，
 * 避免不同回测器以不同年化口径喂给进化器。
 */
export function scoreGenomeFitness(input: GenomeFitnessInput): GenomeFitnessResult {
  const m = input.metrics;
  const required: Array<[string, number | null]> = [
    ["annualReturn", finite(m.annualReturn)],
    ["sharpe", finite(m.sharpe)],
    ["sortino", finite(m.sortino)],
    ["calmar", finite(m.calmar)],
    ["maxDrawdown", finite(m.maxDrawdown)],
    ["conditionalValueAtRisk95", finite(m.conditionalValueAtRisk95)],
    ["turnover", finite(m.turnover)],
    ["positivePeriodRate", finite(m.positivePeriodRate)],
  ];
  const missingMetrics = required.filter(([, value]) => value == null).map(([key]) => key);
  const annualReturn = finite(m.annualReturn);
  const sharpe = finite(m.sharpe);
  const sortino = finite(m.sortino);
  const calmar = finite(m.calmar);
  const maxDrawdown = finite(m.maxDrawdown);
  const cvar95 = finite(m.conditionalValueAtRisk95);
  const turnover = finite(m.turnover);
  const positivePeriodRate = finite(m.positivePeriodRate);
  const maxConsecutiveLosses = finite(m.maxConsecutiveLosses) ?? 0;
  const benchmark = m.benchmark;

  const dimensions = {
    return: scoreRange(annualReturn, -0.1, 0.3),
    riskAdjusted:
      0.45 * scoreRange(sharpe, -0.5, 2.5) +
      0.35 * scoreRange(sortino, -0.5, 3.5) +
      0.2 * scoreRange(calmar, -0.5, 2.5),
    risk:
      0.65 * (maxDrawdown == null ? 0 : 1 - clamp01(maxDrawdown / 0.4)) +
      0.35 * (cvar95 == null ? 0 : 1 - clamp01(cvar95 / 0.08)),
    stability:
      0.7 * scoreRange(positivePeriodRate, 0.4, 0.65) +
      0.3 * (1 - clamp01(maxConsecutiveLosses / 12)),
    benchmark: benchmark
      ? 0.6 * scoreRange(finite(benchmark.alpha), -0.05, 0.15) +
        0.4 * scoreRange(finite(benchmark.informationRatio), -0.5, 1.5)
      : 0.5,
    capacity:
      0.6 * (turnover == null ? 0 : 1 - clamp01(turnover / 18)) +
      0.4 * scoreRange(finite(m.tradeCount), 5, 80),
  };
  const score =
    100 *
    (0.2 * dimensions.return +
      0.3 * dimensions.riskAdjusted +
      0.2 * dimensions.risk +
      0.1 * dimensions.stability +
      0.15 * dimensions.benchmark +
      0.05 * dimensions.capacity);
  const failedGates: string[] = [];
  if (input.sampleSize < 60) failedGates.push("sample_size_below_60");
  if (sharpe == null || sharpe < 0.3) failedGates.push("sharpe_below_0.3");
  if (maxDrawdown == null || maxDrawdown > 0.3) failedGates.push("max_drawdown_above_0.3");
  if (cvar95 == null || cvar95 > 0.08) failedGates.push("cvar95_above_0.08");
  if (positivePeriodRate == null || positivePeriodRate < 0.4)
    failedGates.push("positive_period_rate_below_0.4");
  if (missingMetrics.length > 0) failedGates.push("incomplete_performance_metrics");

  return {
    score: Number(score.toFixed(2)),
    eligible: failedGates.length === 0,
    dimensions: Object.fromEntries(
      Object.entries(dimensions).map(([key, value]) => [key, Number((value * 100).toFixed(2))])
    ) as GenomeFitnessResult["dimensions"],
    failedGates,
    missingMetrics,
    gateVersion: "genome-fitness-v1",
  };
}
