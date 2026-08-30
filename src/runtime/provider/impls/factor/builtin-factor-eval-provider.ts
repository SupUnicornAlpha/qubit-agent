/**
 * 内置 BuiltinFactorEvalProvider
 *
 * 纯 TS 算法实现 §6.2 因子评估指标：
 *   - 横截面 daily IC / RankIC → 时序均值 (IC)
 *   - IR = mean(daily_ic) / std(daily_ic) × √252（年化）
 *   - decay curve：多个 horizon 的 IC 序列
 *   - group returns：按因子值分位数分 N 组的未来平均收益
 *   - turnover：相邻调仓日的 top-quintile 持仓重合度补集
 */

import type {
  FactorComputeRow,
  FactorEvalRequest,
  FactorEvalResult,
  FactorEvaluationProvider,
  ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "factor_eval",
  key: "builtin",
  displayName: "Builtin Factor Eval（纯 TS）",
  description:
    "Pearson IC / Spearman RankIC（横截面 daily）+ HAC 显著性 + 年化 IR + decay curve + group returns + turnover。",
  version: "0.3.0",
  capability: {
    features: [
      "pearson_ic",
      "spearman_rank_ic",
      "daily_cross_sectional_ic",
      "newey_west_hac_inference",
      "annualized_ir",
      "decay_curve",
      "group_returns",
      "turnover",
    ],
    performanceProfile: "neartime",
  },
  isBuiltin: true,
  isFallback: true,
};

function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) return 0;
    sx += x;
    sy += y;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) return 0;
    const a = x - mx;
    const b = y - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 1e-12 ? num / denom : 0;
}

function rank(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1]?.v === indexed[i]?.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k]?.i] = avg;
    i = j + 1;
  }
  return ranks;
}

interface PairsByDate {
  date: string;
  xs: number[];
  ys: number[];
  symbols: string[];
}

/** 按 date 把因子值与未来收益配对，得到每日横截面 */
function joinByDate(values: FactorComputeRow[], futures: FactorComputeRow[]): PairsByDate[] {
  // {date → {sym → fut}}
  const futMap = new Map<string, Map<string, number>>();
  for (const r of futures) {
    if (r.value == null || !Number.isFinite(r.value)) continue;
    let d = futMap.get(r.date);
    if (!d) {
      d = new Map();
      futMap.set(r.date, d);
    }
    d.set(r.symbol, r.value);
  }
  const byDate = new Map<string, { xs: number[]; ys: number[]; symbols: string[] }>();
  for (const v of values) {
    if (v.value == null || !Number.isFinite(v.value)) continue;
    const futAtDate = futMap.get(v.date);
    if (!futAtDate) continue;
    const fut = futAtDate.get(v.symbol);
    if (fut == null) continue;
    let agg = byDate.get(v.date);
    if (!agg) {
      agg = { xs: [], ys: [], symbols: [] };
      byDate.set(v.date, agg);
    }
    agg.xs.push(v.value);
    agg.ys.push(fut);
    agg.symbols.push(v.symbol);
  }
  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({ date, ...v }));
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let acc = 0;
  for (const x of arr) acc += (x - m) ** 2;
  return Math.sqrt(acc / (arr.length - 1));
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return Math.max(0, Math.min(1, 0.5 * (1 + sign * erf)));
}

function neweyWestInference(values: number[]): {
  mean: number;
  lag: number;
  stdError: number | null;
  tStatistic: number | null;
  pValue: number | null;
  positiveRate: number;
} {
  const n = values.length;
  const average = mean(values);
  const positiveRate = n > 0 ? values.filter((value) => value > 0).length / n : 0;
  if (n < 2)
    return { mean: average, lag: 0, stdError: null, tStatistic: null, pValue: null, positiveRate };
  const lag = Math.max(0, Math.min(n - 1, Math.floor(4 * (n / 100) ** (2 / 9))));
  const centered = values.map((value) => value - average);
  let longRunVariance = centered.reduce((sum, value) => sum + value * value, 0) / n;
  for (let k = 1; k <= lag; k += 1) {
    let covariance = 0;
    for (let index = k; index < n; index += 1)
      covariance += centered[index]! * centered[index - k]!;
    covariance /= n;
    longRunVariance += 2 * (1 - k / (lag + 1)) * covariance;
  }
  const stdError = longRunVariance > 1e-18 ? Math.sqrt(longRunVariance / n) : null;
  const tStatistic = stdError ? average / stdError : null;
  const pValue = tStatistic == null ? null : 2 * (1 - normalCdf(Math.abs(tStatistic)));
  return { mean: average, lag, stdError, tStatistic, pValue, positiveRate };
}

function factorStatisticalReport(
  ics: number[],
  rankIcs: number[]
): NonNullable<FactorEvalResult["statisticalReport"]> {
  const ic = neweyWestInference(ics);
  const rankIc = neweyWestInference(rankIcs);
  const enoughDailyObservations = ics.length >= 60;
  const significantIc = ic.pValue != null && ic.pValue <= 0.05;
  const significantRankIc = rankIc.pValue != null && rankIc.pValue <= 0.05;
  return {
    version: "factor-statistical-validation-v1",
    dailyObservations: ics.length,
    hacLag: Math.max(ic.lag, rankIc.lag),
    ic: {
      mean: Number(ic.mean.toFixed(6)),
      neweyWestStdError: ic.stdError == null ? null : Number(ic.stdError.toFixed(6)),
      tStatistic: ic.tStatistic == null ? null : Number(ic.tStatistic.toFixed(6)),
      pValue: ic.pValue == null ? null : Number(ic.pValue.toFixed(6)),
      positiveRate: Number(ic.positiveRate.toFixed(6)),
    },
    rankIc: {
      mean: Number(rankIc.mean.toFixed(6)),
      neweyWestStdError: rankIc.stdError == null ? null : Number(rankIc.stdError.toFixed(6)),
      tStatistic: rankIc.tStatistic == null ? null : Number(rankIc.tStatistic.toFixed(6)),
      pValue: rankIc.pValue == null ? null : Number(rankIc.pValue.toFixed(6)),
      positiveRate: Number(rankIc.positiveRate.toFixed(6)),
    },
    status:
      enoughDailyObservations && (significantIc || significantRankIc) ? "passed" : "research_only",
    checks: [
      {
        key: "minimum_daily_observations",
        state: enoughDailyObservations ? "pass" : "unknown",
        evidence: `dailyCrossSections=${ics.length}; required=60`,
      },
      {
        key: "ic_significance",
        state: ic.pValue == null ? "unknown" : significantIc ? "pass" : "fail",
        evidence: `NeweyWest p=${ic.pValue == null ? "unknown" : ic.pValue}`,
      },
      {
        key: "rank_ic_significance",
        state: rankIc.pValue == null ? "unknown" : significantRankIc ? "pass" : "fail",
        evidence: `NeweyWest p=${rankIc.pValue == null ? "unknown" : rankIc.pValue}`,
      },
    ],
  };
}

/** 横截面 daily IC 时序：返回每日 (pearson, spearman) */
function dailyIcSeries(pairs: PairsByDate[]): {
  dates: string[];
  ics: number[];
  rankIcs: number[];
} {
  const dates: string[] = [];
  const ics: number[] = [];
  const rankIcs: number[] = [];
  for (const p of pairs) {
    if (p.xs.length < 3) continue;
    dates.push(p.date);
    ics.push(pearson(p.xs, p.ys));
    rankIcs.push(pearson(rank(p.xs), rank(p.ys)));
  }
  return { dates, ics, rankIcs };
}

/** 按因子值分 N 组，每组下一期平均收益（用所有横截面平均后再合并） */
function groupReturns(pairs: PairsByDate[], groupCount: number): number[] {
  if (groupCount < 2) return [];
  const buckets: number[][] = Array.from({ length: groupCount }, () => []);
  for (const p of pairs) {
    if (p.xs.length < groupCount) continue;
    // 按 xs 排序得到 group index
    const idx = p.xs.map((_, i) => i);
    idx.sort((a, b) => (p.xs[a] ?? 0) - (p.xs[b] ?? 0));
    const size = p.xs.length / groupCount;
    for (let k = 0; k < idx.length; k++) {
      const g = Math.min(groupCount - 1, Math.floor(k / size));
      const index = idx[k];
      const value = index === undefined ? undefined : p.ys[index];
      const bucket = buckets[g];
      if (bucket && value !== undefined) bucket.push(value);
    }
  }
  return buckets.map((b) => (b.length ? mean(b) : 0));
}

/** turnover：相邻横截面 top-quintile 持仓变化率（取 top 20%） */
function topQuintileTurnover(pairs: PairsByDate[]): number {
  let acc = 0;
  let cnt = 0;
  let prevTop: Set<string> | null = null;
  for (const p of pairs) {
    const k = Math.max(1, Math.floor(p.symbols.length * 0.2));
    const idx = p.symbols.map((_, i) => i);
    idx.sort((a, b) => (p.xs[b] ?? 0) - (p.xs[a] ?? 0));
    const topNow = new Set(
      idx
        .slice(0, k)
        .map((i) => p.symbols[i])
        .filter((symbol): symbol is string => symbol !== undefined)
    );
    if (prevTop) {
      const inter = [...topNow].filter((s) => prevTop?.has(s)).length;
      const change = 1 - inter / topNow.size;
      acc += change;
      cnt += 1;
    }
    prevTop = topNow;
  }
  return cnt > 0 ? acc / cnt : 0;
}

export class BuiltinFactorEvalProvider implements FactorEvaluationProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async evaluate(input: FactorEvalRequest): Promise<FactorEvalResult> {
    const t0 = Date.now();
    const groupCount = input.groupCount ?? 5;

    // ─── 1) 主 horizon 评估 ───
    const futures = input.futureReturns ?? [];
    const pairs = joinByDate(input.values, futures);
    const daily = dailyIcSeries(pairs);

    let sampleSize = 0;
    for (const p of pairs) sampleSize += p.xs.length;

    if (sampleSize < 5 || daily.ics.length === 0) {
      return {
        ic: 0,
        rankIc: 0,
        ir: 0,
        turnover: 0,
        decayCurve: [],
        groupReturns: [],
        sampleSize,
        latencyMs: Date.now() - t0,
        error: "sample_size_too_small",
      };
    }

    const ic = mean(daily.ics);
    const rankIc = mean(daily.rankIcs);
    const icStd = std(daily.ics);
    const ir = icStd > 1e-9 ? (ic / icStd) * Math.sqrt(252) : 0;

    // ─── 2) decay curve（多期 horizon 的 IC） ───
    const decayCurve: number[] = [];
    if (input.futureReturnsByHorizon) {
      const horizons = Object.keys(input.futureReturnsByHorizon)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);
      for (const h of horizons) {
        const rows = input.futureReturnsByHorizon[h] ?? [];
        const pairsH = joinByDate(input.values, rows);
        const dailyH = dailyIcSeries(pairsH);
        decayCurve.push(Number(mean(dailyH.ics).toFixed(4)));
      }
    }

    // ─── 3) group returns ───
    const grpRet = groupReturns(pairs, groupCount).map((x) => Number(x.toFixed(6)));

    // ─── 4) turnover ───
    const turnover = Number(topQuintileTurnover(pairs).toFixed(4));
    const statisticalReport = factorStatisticalReport(daily.ics, daily.rankIcs);

    return {
      ic: Number(ic.toFixed(4)),
      rankIc: Number(rankIc.toFixed(4)),
      ir: Number(ir.toFixed(4)),
      turnover,
      decayCurve,
      groupReturns: grpRet,
      sampleSize,
      latencyMs: Date.now() - t0,
      statisticalReport,
    };
  }
}
