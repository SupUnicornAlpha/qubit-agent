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

import {
  type FactorComputeRow,
  type FactorEvalRequest,
  type FactorEvalResult,
  type FactorEvaluationProvider,
  type ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "factor_eval",
  key: "builtin",
  displayName: "Builtin Factor Eval（纯 TS）",
  description:
    "Pearson IC / Spearman RankIC（横截面 daily） + 年化 IR + decay curve + group returns + turnover。",
  version: "0.2.0",
  capability: {
    features: [
      "pearson_ic",
      "spearman_rank_ic",
      "daily_cross_sectional_ic",
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
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
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
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg;
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
function joinByDate(
  values: FactorComputeRow[],
  futures: FactorComputeRow[]
): PairsByDate[] {
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

/** 横截面 daily IC 时序：返回每日 (pearson, spearman) */
function dailyIcSeries(pairs: PairsByDate[]): { dates: string[]; ics: number[]; rankIcs: number[] } {
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
    idx.sort((a, b) => p.xs[a]! - p.xs[b]!);
    const size = p.xs.length / groupCount;
    for (let k = 0; k < idx.length; k++) {
      const g = Math.min(groupCount - 1, Math.floor(k / size));
      buckets[g]!.push(p.ys[idx[k]!]!);
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
    idx.sort((a, b) => p.xs[b]! - p.xs[a]!);
    const topNow = new Set(idx.slice(0, k).map((i) => p.symbols[i]!));
    if (prevTop) {
      const inter = [...topNow].filter((s) => prevTop!.has(s)).length;
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

    return {
      ic: Number(ic.toFixed(4)),
      rankIc: Number(rankIc.toFixed(4)),
      ir: Number(ir.toFixed(4)),
      turnover,
      decayCurve,
      groupReturns: grpRet,
      sampleSize,
      latencyMs: Date.now() - t0,
    };
  }
}
