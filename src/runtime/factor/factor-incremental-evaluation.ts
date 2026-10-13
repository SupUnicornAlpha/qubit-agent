import { createHash } from "node:crypto";
import { parse } from "../provider/impls/factor/qlib-expr/parser";
import type { BacktestDataset, FactorComputeRow } from "../provider/types";
import type { FactorComparisonSpec } from "../research-program/types";

export type IncrementalVerdict =
  | "duplicate"
  | "insufficient_evidence"
  | "no_incremental_value"
  | "worth_validation";
export type ComparisonFactor = {
  id: string;
  name: string;
  expr: string;
  fingerprint: string;
  direction: 1 | -1;
  rows: FactorComputeRow[];
};
type Period = {
  date: string;
  entryDate: string;
  exitDate: string;
  gross: number[];
  turnover: number[];
};
export type FactorIncrementalReport = {
  version: "factor-incremental-v1";
  scope: "development_only";
  datasetSnapshotId: string;
  method: FactorComparisonSpec;
  horizonDays: number;
  candidate: Omit<ComparisonFactor, "rows">;
  references: Array<Omit<ComparisonFactor, "rows">>;
  verdict: IncrementalVerdict;
  reasons: string[];
  expression: { candidateCanonicalHash: string; duplicateFactorIds: string[] };
  signal: {
    days: number;
    eligibleDays: number;
    coverage: number;
    candidateRankIc: number | null;
    residualRankIc: number | null;
    residualDays: number;
    pairs: Array<{
      factorId: string;
      days: number;
      meanRankCorrelation: number | null;
      meanAbsoluteRankCorrelation: number | null;
      coverage: number;
    }>;
  };
  returns: { pairs: Array<{ factorId: string; periods: number; correlation: number | null }> };
  portfolio: {
    periods: number;
    eligiblePeriods: number;
    coverage: number;
    baseline: PortfolioMetrics;
    candidate: PortfolioMetrics;
    augmented: PortfolioMetrics;
    deltaNetMeanBps: number | null;
    stability: Array<{
      segment: number;
      startDate: string;
      endDate: string;
      periods: number;
      deltaNetMeanBps: number | null;
    }>;
    costSensitivity: Array<{ costBps: number; deltaNetMeanBps: number | null }>;
    series: Array<{
      date: string;
      entryDate: string;
      exitDate: string;
      baselineNetBps: number;
      augmentedNetBps: number;
      deltaNetBps: number;
    }>;
  };
  limitations: string[];
};
export type PortfolioMetrics = {
  grossMeanBps: number | null;
  netMeanBps: number | null;
  meanTargetTurnover: number | null;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
export function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length !== ys.length || xs.length < 2) return null;
  const mx = mean(xs) ?? 0;
  const my = mean(ys) ?? 0;
  let xy = 0;
  let xx = 0;
  let yy = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = (xs[i] ?? 0) - mx;
    const y = (ys[i] ?? 0) - my;
    xy += x * y;
    xx += x * x;
    yy += y * y;
  }
  if (xx <= 1e-20 || yy <= 1e-20) return null;
  return Math.max(-1, Math.min(1, xy / Math.sqrt(xx * yy)));
}
export function averageRanks(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = values.map(() => 0);
  for (let start = 0; start < sorted.length; ) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]?.value === sorted[start]?.value) end++;
    for (let i = start; i < end; i++) {
      const item = sorted[i];
      if (item) ranks[item.index] = (start + end - 1) / 2;
    }
    start = end;
  }
  return ranks;
}
export function canonicalExpressionHash(expr: string): string {
  // Parentheses, whitespace and $field prefixes are normalized by the parser.
  // No algebraic simplification: identities can differ at missing values or zero divisors.
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(parse(expr)))
    .digest("hex")}`;
}
function weights(scores: number[]): number[] | null {
  const center = mean(scores) ?? 0;
  const demeaned = scores.map((x) => x - center);
  const gross = demeaned.reduce((a, b) => a + Math.abs(b), 0);
  return gross > 1e-12 ? demeaned.map((x) => x / gross) : null;
}
function rowMap(rows: FactorComputeRow[]) {
  const map = new Map<string, Map<string, number>>();
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.date}\0${row.symbol}`;
    if (seen.has(key)) throw new Error("comparison_duplicate_observation");
    seen.add(key);
    if (!finite(row.value)) continue;
    const day = map.get(row.date) ?? new Map<string, number>();
    day.set(row.symbol, row.value);
    map.set(row.date, day);
  }
  return map;
}
function net(period: Period, index: number, cost: number): number {
  return (period.gross[index] ?? 0) - ((period.turnover[index] ?? 0) * cost) / 10_000;
}
function metrics(periods: Period[], index: number, cost: number): PortfolioMetrics {
  return {
    grossMeanBps: mean(periods.map((p) => (p.gross[index] ?? 0) * 10_000)),
    netMeanBps: mean(periods.map((p) => net(p, index, cost) * 10_000)),
    meanTargetTurnover: mean(periods.map((p) => p.turnover[index] ?? 0)),
  };
}
const delta = (periods: Period[], cost: number) =>
  mean(periods.map((p) => (net(p, 2, cost) - net(p, 0, cost)) * 10_000));

/** Offline screening, never a sealed validation or a tradable backtest. All allocation rules are fixed before this call. */
export function evaluateFactorIncrement(input: {
  candidate: ComparisonFactor;
  references: ComparisonFactor[];
  dataset: BacktestDataset;
  method: FactorComparisonSpec;
  horizonDays: number;
  startDate: string;
  endDate: string;
}): FactorIncrementalReport {
  const { candidate, references, dataset, method, horizonDays } = input;
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || !references.length)
    throw new Error("comparison_method_invalid");
  const factors = [candidate, ...references];
  const maps = factors.map((f) => rowMap(f.rows));
  const symbols = Object.keys(dataset.barsBySymbol).sort();
  const prices = new Map(
    symbols.map((symbol) => [
      symbol,
      new Map(
        (dataset.barsBySymbol[symbol] ?? []).map((bar) => [bar.timestamp.slice(0, 10), bar.open])
      ),
    ])
  );
  const dates = [
    ...new Set(
      Object.values(dataset.barsBySymbol).flatMap((bars) =>
        bars.map((b) => b.timestamp.slice(0, 10))
      )
    ),
  ]
    .filter((date) => date >= input.startDate && date <= input.endDate)
    .sort();
  const rankIc: number[] = [];
  const residualIc: number[] = [];
  const pairCorrelations: number[][] = references.map(() => []);
  const pairAvailable = references.map(() => 0);
  const periods: Period[] = [];
  let eligiblePeriods = 0;
  let eligibleDays = 0;
  let signalDays = 0;
  let previous: Map<string, number>[] = [];
  const minimumSymbols = 5;
  for (let di = 0; di + horizonDays + 1 < dates.length; di++) {
    const date = dates[di];
    const entryDate = dates[di + 1];
    const exitDate = dates[di + horizonDays + 1];
    if (!date || !entryDate || !exitDate) continue;
    eligibleDays++;
    const onSchedule = di % horizonDays === 0;
    if (onSchedule) eligiblePeriods++;
    const future = (symbol: string) => {
      const p = prices.get(symbol);
      const a = p?.get(entryDate);
      const b = p?.get(exitDate);
      return finite(a) && finite(b) && a > 0 && b > 0 ? b / a - 1 : null;
    };
    const days = maps.map((map) => map.get(date) ?? new Map<string, number>());
    const candidateDay = days[0] ?? new Map<string, number>();
    references.forEach((ref, ri) => {
      const other = days[ri + 1] ?? new Map<string, number>();
      const overlap = symbols.filter((symbol) => candidateDay.has(symbol) && other.has(symbol));
      pairAvailable[ri] = (pairAvailable[ri] ?? 0) + overlap.length / symbols.length;
      if (overlap.length < minimumSymbols) return;
      const r = correlation(
        averageRanks(overlap.map((s) => (candidateDay.get(s) ?? 0) * candidate.direction)),
        averageRanks(overlap.map((s) => (other.get(s) ?? 0) * ref.direction))
      );
      if (r !== null) pairCorrelations[ri]?.push(r);
    });
    // Select the common universe solely from signals available at decision time.
    const common = symbols.filter((symbol) => days.every((day) => day.has(symbol)));
    if (common.length < minimumSymbols || common.length / symbols.length < 0.8) continue;
    const signedRanks = days.map((day, fi) =>
      averageRanks(common.map((symbol) => (day.get(symbol) ?? 0) * (factors[fi]?.direction ?? 1)))
    );
    const candidateRank = signedRanks[0] ?? [];
    const baselineRank = common.map(
      (_, i) => mean(signedRanks.slice(1).map((r) => r[i] ?? 0)) ?? 0
    );
    const candidateWeights = weights(candidateRank);
    const baselineWeights = weights(baselineRank);
    if (!candidateWeights || !baselineWeights) continue;
    const augmentedWeights = weights(
      candidateWeights.map(
        (w, i) =>
          method.candidateWeight * w + (1 - method.candidateWeight) * (baselineWeights[i] ?? 0)
      )
    );
    if (!augmentedWeights) continue;
    signalDays++;
    const labelled = common
      .map((symbol, index) => ({ index, value: future(symbol) }))
      .filter((row): row is { index: number; value: number } => finite(row.value));
    if (labelled.length >= minimumSymbols) {
      const ys = averageRanks(labelled.map((r) => r.value));
      const cs = labelled.map((r) => candidateRank[r.index] ?? 0);
      const bs = labelled.map((r) => baselineRank[r.index] ?? 0);
      const ic = correlation(averageRanks(cs), ys);
      if (ic !== null) rankIc.push(ic);
      const cm = mean(cs) ?? 0;
      const bm = mean(bs) ?? 0;
      const denom = bs.reduce((sum, b) => sum + (b - bm) ** 2, 0);
      const beta =
        denom > 1e-12
          ? cs.reduce((sum, c, i) => sum + (c - cm) * ((bs[i] ?? 0) - bm), 0) / denom
          : 0;
      const residual = cs.map((c, i) => c - cm - beta * ((bs[i] ?? 0) - bm));
      if (residual.some((r) => Math.abs(r) > 1e-8)) {
        const ic = correlation(averageRanks(residual), ys);
        if (ic !== null) residualIc.push(ic);
      }
    }
    if (!onSchedule) continue;
    const returns = common.map(future);
    // Missing future prices never cause a surviving stock to receive more weight.
    if (returns.some((r) => r === null)) continue;
    const refWeights = signedRanks.slice(1).map(weights);
    const allWeights = [baselineWeights, candidateWeights, augmentedWeights, ...refWeights];
    if (allWeights.some((w) => w === null)) continue;
    const holdings = allWeights.map(
      (ws) => new Map(common.map((symbol, i) => [symbol, ws?.[i] ?? 0]))
    );
    // If a scheduled period is missing, break the proxy into segments: charge liquidation
    // of prior holdings and entry again. Never imply continuous P&L across missing data.
    if (periods.length && periods.at(-1)?.exitDate !== entryDate) {
      const prior = periods.at(-1);
      if (prior)
        prior.turnover = prior.turnover.map(
          (t, i) => t + [...(previous[i]?.values() ?? [])].reduce((a, b) => a + Math.abs(b), 0)
        );
      previous = [];
    }
    periods.push({
      date,
      entryDate,
      exitDate,
      gross: allWeights.map((ws) =>
        (ws ?? []).reduce((sum, w, i) => sum + w * (returns[i] ?? 0), 0)
      ),
      turnover: holdings.map((now, i) =>
        [...new Set([...now.keys(), ...(previous[i]?.keys() ?? [])])].reduce(
          (sum, s) => sum + Math.abs((now.get(s) ?? 0) - (previous[i]?.get(s) ?? 0)),
          0
        )
      ),
    });
    previous = holdings;
  }
  const last = periods.at(-1);
  if (last)
    last.turnover = last.turnover.map(
      (t, i) => t + [...(previous[i]?.values() ?? [])].reduce((a, b) => a + Math.abs(b), 0)
    );
  const expressionHash = canonicalExpressionHash(candidate.expr);
  const duplicateFactorIds = references
    .filter(
      (ref) =>
        ref.direction === candidate.direction &&
        canonicalExpressionHash(ref.expr) === expressionHash
    )
    .map((ref) => ref.id);
  const coverage = eligiblePeriods ? periods.length / eligiblePeriods : 0;
  const stability = Array.from({ length: 3 }, (_, part) => {
    const slice = periods.slice(
      Math.floor((periods.length * part) / 3),
      Math.floor((periods.length * (part + 1)) / 3)
    );
    return {
      segment: part + 1,
      startDate: slice[0]?.date ?? "",
      endDate: slice.at(-1)?.date ?? "",
      periods: slice.length,
      deltaNetMeanBps: delta(slice, method.costBps),
    };
  });
  const improvement = delta(periods, method.costBps);
  const insufficient =
    rankIc.length < 60 ||
    periods.length < 20 ||
    coverage < 0.8 ||
    signalDays / Math.max(1, eligibleDays) < 0.8;
  const stableGain =
    !insufficient &&
    (improvement ?? 0) >= 0.1 &&
    (mean(rankIc) ?? 0) > 0 &&
    stability.every((part) => part.periods >= 3 && (part.deltaNetMeanBps ?? 0) > 0);
  const verdict: IncrementalVerdict = duplicateFactorIds.length
    ? "duplicate"
    : insufficient
      ? "insufficient_evidence"
      : stableGain
        ? "worth_validation"
        : "no_incremental_value";
  const omitRows = ({ rows: _rows, ...factor }: ComparisonFactor) => factor;
  return {
    version: "factor-incremental-v1",
    scope: "development_only",
    datasetSnapshotId: dataset.snapshotId,
    method,
    horizonDays,
    candidate: omitRows(candidate),
    references: references.map(omitRows),
    verdict,
    reasons: [
      ...(duplicateFactorIds.length ? ["canonical_expression_already_in_library"] : []),
      ...(insufficient ? ["insufficient_common_sample_or_coverage"] : []),
      ...(stableGain ? ["positive_increment_in_three_development_segments"] : []),
      ...(!insufficient && !stableGain ? ["no_stable_increment_under_fixed_allocation"] : []),
    ],
    expression: { candidateCanonicalHash: expressionHash, duplicateFactorIds },
    signal: {
      days: signalDays,
      eligibleDays,
      coverage: signalDays / Math.max(1, eligibleDays),
      candidateRankIc: mean(rankIc),
      residualRankIc: mean(residualIc),
      residualDays: residualIc.length,
      pairs: references.map((ref, i) => ({
        factorId: ref.id,
        days: pairCorrelations[i]?.length ?? 0,
        meanRankCorrelation: mean(pairCorrelations[i] ?? []),
        meanAbsoluteRankCorrelation: mean((pairCorrelations[i] ?? []).map(Math.abs)),
        coverage: (pairAvailable[i] ?? 0) / Math.max(1, eligibleDays),
      })),
    },
    returns: {
      pairs: references.map((ref, i) => ({
        factorId: ref.id,
        periods: periods.length,
        correlation: correlation(
          periods.map((p) => p.gross[1] ?? 0),
          periods.map((p) => p.gross[i + 3] ?? 0)
        ),
      })),
    },
    portfolio: {
      periods: periods.length,
      eligiblePeriods,
      coverage,
      baseline: metrics(periods, 0, method.costBps),
      candidate: metrics(periods, 1, method.costBps),
      augmented: metrics(periods, 2, method.costBps),
      deltaNetMeanBps: improvement,
      stability,
      costSensitivity: [...new Set([0, method.costBps, 2 * method.costBps])].map((costBps) => ({
        costBps,
        deltaNetMeanBps: delta(periods, costBps),
      })),
      series: periods.map((p) => ({
        date: p.date,
        entryDate: p.entryDate,
        exitDate: p.exitDate,
        baselineNetBps: net(p, 0, method.costBps) * 10_000,
        augmentedNetBps: net(p, 2, method.costBps) * 10_000,
        deltaNetBps: (net(p, 2, method.costBps) - net(p, 0, method.costBps)) * 10_000,
      })),
    },
    limitations: [
      "开发集筛选，不是封存验证，不自动晋级因子。",
      "仅规范化语法，不证明不同公式在数学上等价。",
      "按日截面排序比较；残差信号只扣除已选基准组合的线性排序暴露，不等于行业/风险中性化。",
      "信号在收盘后形成，次日开盘进入，持有固定h个共同交易日到开盘；组合收益代理按预定间隔不重叠采样。",
      "基准等权合并，加入权重固定；组合净敞口0、目标总敞口1，含空头。未模拟借券、停牌、限价、容量和订单成交。",
      "成本按目标权重变化近似（含首笔进入、分段退出及末笔清仓），未模拟持仓漂移和费用对净值的反馈。",
      "共同样本至少5个标的；缺少未来价格的组合期整期不评分，不以幸存标的重新配权。",
      "进一步验证建议还要求平均每期净增量至少0.1 bps，避免浮点噪声被当作改善。",
      "收益与IC统计是描述性证据，未进行多重搜索校正或宣称统计显著性。",
    ],
  };
}
