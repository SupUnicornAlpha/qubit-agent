/**
 * 统一的策略绩效指标计算。
 *
 * 所有数值均以小数表达（0.12 = 12%），而不是展示层百分数。它不依赖数据源或撮合
 * 引擎，因而可被事件驱动、单标的和 Python 策略回测复用，避免各处对 Sharpe / 回撤
 * 使用不同口径。
 */

export interface PerformanceEquityPoint {
  equity: number;
  /** 与 equity 同日期、同起始资金归一化的基准净值，可选。 */
  benchmarkEquity?: number;
}

export interface PerformanceTrade {
  qty: number;
  price: number;
  commission?: number;
}

export interface BenchmarkPerformanceMetrics {
  totalReturn: number;
  annualReturn: number;
  beta: number;
  alpha: number;
  correlation: number;
  informationRatio: number;
  trackingError: number;
  upCapture: number | null;
  downCapture: number | null;
  observations: number;
}

export interface PerformanceMetrics {
  totalReturn: number;
  /** 几何年化收益（CAGR），而非日均收益简单年化。 */
  annualReturn: number;
  annualVol: number;
  sharpe: number;
  downsideDeviation: number;
  sortino: number;
  maxDrawdown: number;
  maxDrawdownDuration: number;
  calmar: number;
  ulcerIndex: number;
  valueAtRisk95: number;
  conditionalValueAtRisk95: number;
  positivePeriodRate: number;
  maxConsecutiveLosses: number;
  returnSkewness: number;
  excessKurtosis: number;
  turnover: number;
  tradeCount: number;
  totalCommission: number;
  benchmark: BenchmarkPerformanceMetrics | null;
}

export interface ComputePerformanceMetricsInput {
  equityCurve: PerformanceEquityPoint[];
  initialCapital: number;
  trades?: PerformanceTrade[];
  periodsPerYear?: number;
  /** 年化无风险利率；默认 0，便于没有现金利率序列的回测保持确定性。 */
  riskFreeRateAnnual?: number;
}

const EPSILON = 1e-12;

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleStd(values: number[], average = mean(values)): number {
  if (values.length < 2) return 0;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  );
}

function percentile(values: number[], level: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * level)));
  return sorted[index] ?? 0;
}

function correlation(left: number[], right: number[]): number {
  if (left.length < 2 || left.length !== right.length) return 0;
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index++) {
    const leftDelta = left[index]! - leftMean;
    const rightDelta = right[index]! - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > EPSILON ? finite(covariance / denominator) : 0;
}

function moments(returns: number[]): { skewness: number; excessKurtosis: number } {
  if (returns.length < 3) return { skewness: 0, excessKurtosis: 0 };
  const average = mean(returns);
  const std = sampleStd(returns, average);
  if (std <= EPSILON) return { skewness: 0, excessKurtosis: 0 };
  const third = mean(returns.map((value) => ((value - average) / std) ** 3));
  const fourth = mean(returns.map((value) => ((value - average) / std) ** 4));
  // 小样本时不试图做无偏校正；此处用于比较策略的尾部形态而非统计推断。
  return {
    skewness: finite(third),
    excessKurtosis: finite(fourth - 3),
  };
}

/**
 * 从净值曲线计算完整绩效指标。少于两个有效观测时返回全零、但不会返回 NaN/Infinity。
 */
export function computePerformanceMetrics(
  input: ComputePerformanceMetricsInput
): PerformanceMetrics {
  const periodsPerYear = Math.max(1, Math.floor(input.periodsPerYear ?? 252));
  const riskFreePeriod =
    Math.pow(1 + Math.max(-0.99, input.riskFreeRateAnnual ?? 0), 1 / periodsPerYear) - 1;
  const points = input.equityCurve.filter(
    (point) => Number.isFinite(point.equity) && point.equity > 0
  );
  const initialCapital = input.initialCapital > 0 ? input.initialCapital : (points[0]?.equity ?? 1);
  const equityReturns: number[] = [];
  const benchmarkReturns: number[] = [];
  const pairedStrategyReturns: number[] = [];
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    equityReturns.push(current.equity / previous.equity - 1);
    if (
      previous.benchmarkEquity != null &&
      current.benchmarkEquity != null &&
      previous.benchmarkEquity > 0 &&
      current.benchmarkEquity > 0
    ) {
      pairedStrategyReturns.push(current.equity / previous.equity - 1);
      benchmarkReturns.push(current.benchmarkEquity / previous.benchmarkEquity - 1);
    }
  }

  const finalEquity = points.at(-1)?.equity ?? initialCapital;
  const totalReturn = finite(finalEquity / initialCapital - 1);
  const years = Math.max(1 / periodsPerYear, equityReturns.length / periodsPerYear);
  const annualReturn =
    finalEquity > 0 ? finite(Math.pow(finalEquity / initialCapital, 1 / years) - 1) : -1;
  const average = mean(equityReturns);
  const periodStd = sampleStd(equityReturns, average);
  const annualVol = periodStd * Math.sqrt(periodsPerYear);
  const excessReturns = equityReturns.map((value) => value - riskFreePeriod);
  const sharpe =
    periodStd > EPSILON ? (mean(excessReturns) / periodStd) * Math.sqrt(periodsPerYear) : 0;
  const downsideReturns = excessReturns.filter((value) => value < 0);
  const downsideDeviation =
    Math.sqrt(mean(downsideReturns.map((value) => value ** 2))) * Math.sqrt(periodsPerYear);
  const sortino =
    downsideDeviation > EPSILON
      ? (annualReturn - (input.riskFreeRateAnnual ?? 0)) / downsideDeviation
      : 0;

  let peak = points[0]?.equity ?? initialCapital;
  let maxDrawdown = 0;
  let drawdownSquareSum = 0;
  let drawdownPeriods = 0;
  let currentDrawdownDuration = 0;
  let maxDrawdownDuration = 0;
  for (const point of points) {
    if (point.equity >= peak) {
      peak = point.equity;
      currentDrawdownDuration = 0;
    } else {
      currentDrawdownDuration++;
      maxDrawdownDuration = Math.max(maxDrawdownDuration, currentDrawdownDuration);
    }
    const drawdown = peak > 0 ? 1 - point.equity / peak : 0;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
    drawdownSquareSum += drawdown ** 2;
    drawdownPeriods++;
  }

  let lossStreak = 0;
  let maxConsecutiveLosses = 0;
  for (const value of equityReturns) {
    if (value < 0) {
      lossStreak++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, lossStreak);
    } else {
      lossStreak = 0;
    }
  }
  const trades = input.trades ?? [];
  const averageEquity =
    points.length > 0 ? mean(points.map((point) => point.equity)) : initialCapital;
  const tradedNotional = trades.reduce((sum, trade) => sum + Math.abs(trade.qty * trade.price), 0);
  const turnover = averageEquity > EPSILON ? tradedNotional / averageEquity / years : 0;
  const totalCommission = trades.reduce(
    (sum, trade) => sum + Math.max(0, trade.commission ?? 0),
    0
  );

  let benchmark: BenchmarkPerformanceMetrics | null = null;
  if (benchmarkReturns.length >= 2) {
    const benchmarkStart =
      points.find((point) => point.benchmarkEquity != null)?.benchmarkEquity ?? initialCapital;
    const benchmarkEnd =
      [...points].reverse().find((point) => point.benchmarkEquity != null)?.benchmarkEquity ??
      benchmarkStart;
    const benchmarkTotalReturn = benchmarkStart > 0 ? benchmarkEnd / benchmarkStart - 1 : 0;
    const benchmarkAnnualReturn = finite(Math.pow(1 + benchmarkTotalReturn, 1 / years) - 1);
    const benchmarkMean = mean(benchmarkReturns);
    const strategyMean = mean(pairedStrategyReturns);
    const benchmarkVariance = sampleStd(benchmarkReturns, benchmarkMean) ** 2;
    // 与 sampleStd 的 n - 1 分母保持一致，避免 Beta 出现系统性向下偏差。
    const covariance =
      pairedStrategyReturns.reduce(
        (sum, value, index) =>
          sum + (value - strategyMean) * (benchmarkReturns[index]! - benchmarkMean),
        0
      ) / (pairedStrategyReturns.length - 1);
    const beta = benchmarkVariance > EPSILON ? covariance / benchmarkVariance : 0;
    const alphaPeriod =
      strategyMean - riskFreePeriod - beta * (benchmarkMean - riskFreePeriod);
    const activeReturns = pairedStrategyReturns.map(
      (value, index) => value - benchmarkReturns[index]!
    );
    const trackingError = sampleStd(activeReturns) * Math.sqrt(periodsPerYear);
    const upPairs = pairedStrategyReturns.filter((_, index) => benchmarkReturns[index]! > 0);
    const upBench = benchmarkReturns.filter((value) => value > 0);
    const downPairs = pairedStrategyReturns.filter((_, index) => benchmarkReturns[index]! < 0);
    const downBench = benchmarkReturns.filter((value) => value < 0);
    benchmark = {
      totalReturn: finite(benchmarkTotalReturn),
      annualReturn: benchmarkAnnualReturn,
      beta: finite(beta),
      alpha: finite(Math.pow(1 + alphaPeriod, periodsPerYear) - 1),
      correlation: correlation(pairedStrategyReturns, benchmarkReturns),
      informationRatio:
        trackingError > EPSILON ? (mean(activeReturns) * periodsPerYear) / trackingError : 0,
      trackingError,
      upCapture:
        upBench.length > 0 && Math.abs(mean(upBench)) > EPSILON
          ? mean(upPairs) / mean(upBench)
          : null,
      downCapture:
        downBench.length > 0 && Math.abs(mean(downBench)) > EPSILON
          ? mean(downPairs) / mean(downBench)
          : null,
      observations: benchmarkReturns.length,
    };
  }

  const worstTail = equityReturns.filter((value) => value <= percentile(equityReturns, 0.05));
  const { skewness, excessKurtosis } = moments(equityReturns);
  return {
    totalReturn,
    annualReturn,
    annualVol: finite(annualVol),
    sharpe: finite(sharpe),
    downsideDeviation: finite(downsideDeviation),
    sortino: finite(sortino),
    maxDrawdown: finite(maxDrawdown),
    maxDrawdownDuration,
    calmar: maxDrawdown > EPSILON ? finite(annualReturn / maxDrawdown) : 0,
    ulcerIndex: drawdownPeriods > 0 ? Math.sqrt(drawdownSquareSum / drawdownPeriods) : 0,
    valueAtRisk95: Math.max(0, -percentile(equityReturns, 0.05)),
    conditionalValueAtRisk95: worstTail.length > 0 ? Math.max(0, -mean(worstTail)) : 0,
    positivePeriodRate:
      equityReturns.length > 0
        ? equityReturns.filter((value) => value > 0).length / equityReturns.length
        : 0,
    maxConsecutiveLosses,
    returnSkewness: skewness,
    excessKurtosis,
    turnover: finite(turnover),
    tradeCount: trades.length,
    totalCommission: finite(totalCommission),
    benchmark,
  };
}
