/**
 * 蒙特卡洛压力测试与重抽样分析服务（Monte Carlo Stress Test & Bootstrap Resampling）
 *
 * 核心功能：
 * 1. 基于历史收益率时序/交易盈亏进行 Block Bootstrap 重抽样（500 ~ 1000 次独立路径模拟）
 * 2. 模拟不同黑天鹅与行情震荡下的极端回撤与收益分布
 * 3. 统计 5% / 50% / 95% 置信区间分位数（Percentiles）
 * 4. 计算破产概率（Probability of Ruin）、最坏回撤与稳健度评分
 * 5. 提取代表性置信度净值曲线供前端图表渲染
 */

import { createHash } from "node:crypto";
import { backtestJobService } from "./backtest-job-service";
import type { BacktestEquityPoint } from "../provider/types";

export interface MonteCarloPercentileMetric {
  p5: number;
  p25: number;
  median: number;
  p75: number;
  p95: number;
}

export interface MonteCarloRepresentativePath {
  date: string;
  p5Worst: number;
  median: number;
  p95Best: number;
}

export interface MonteCarloSimulationResult {
  backtestJobId: string;
  simulationCount: number;
  initialCapital: number;
  metrics: {
    totalReturnPercentiles: MonteCarloPercentileMetric;
    maxDrawdownPercentiles: MonteCarloPercentileMetric;
    cagrPercentiles: MonteCarloPercentileMetric;
    sharpePercentiles: MonteCarloPercentileMetric;
  };
  probabilityOfRuin: number; // 资金缩水超过 50% 的概率 (0 ~ 1.0)
  stressScore: number; // 0 ~ 1.0 稳健度评级
  drawdownRiskRating: "low" | "moderate" | "high" | "critical";
  simulatedPathsSummary: MonteCarloRepresentativePath[];
  meta: {
    sampleDays: number;
    /** Deterministic PRNG seed; same job/options/seed reproduces the paths. */
    seed: number;
    latencyMs: number;
  };
}

export interface RunMonteCarloInput {
  jobId: string;
  simulations?: number;
  blockSize?: number;
  ruinThresholdRatio?: number; // 默认 0.5 (即亏损 50%)
  seed?: number;
}

export class MonteCarloService {
  async run(input: RunMonteCarloInput): Promise<MonteCarloSimulationResult> {
    const t0 = Date.now();
    const sourceJob = await backtestJobService.get(input.jobId);
    if (!sourceJob || !sourceJob.result) {
      throw new Error(`Backtest job or result not found for ID: ${input.jobId}`);
    }

    const equityCurve = sourceJob.result.equityCurve;
    if (!equityCurve || equityCurve.length < 5) {
      throw new Error(`Insufficient equity data for Monte Carlo simulation: ${equityCurve?.length ?? 0} points`);
    }

    const initialCapital = sourceJob.config.capital || 100_000;
    const simulations = Math.min(2000, Math.max(100, input.simulations ?? 500));
    const blockSize = Math.max(1, input.blockSize ?? 5);
    const ruinThreshold = initialCapital * (input.ruinThresholdRatio ?? 0.5);
    const seed = normalizeSeed(
      input.seed ?? `${sourceJob.id}:${simulations}:${blockSize}:${input.ruinThresholdRatio ?? 0.5}`
    );
    const random = createSeededRandom(seed);

    // 1. 提取日度收益率序列
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prev = equityCurve[i - 1]!.equity;
      const cur = equityCurve[i]!.equity;
      const ret = prev > 0 ? (cur - prev) / prev : 0;
      dailyReturns.push(ret);
    }

    const pathLength = dailyReturns.length;
    const simTotalReturns: number[] = [];
    const simMaxDrawdowns: number[] = [];
    const simSharpes: number[] = [];
    const simCAGRs: number[] = [];
    let ruinCount = 0;

    // 记录所有模拟路径在各时间点的净值矩阵 [simIndex][dayIndex]
    const allPaths: number[][] = [];

    // 2. 执行 Block Bootstrap 模拟循环
    for (let s = 0; s < simulations; s++) {
      const simPath: number[] = [initialCapital];
      let currentEquity = initialCapital;
      let peak = initialCapital;
      let maxDD = 0;
      let hasRuined = false;

      let daysGenerated = 0;
      while (daysGenerated < pathLength) {
        // 随机选择一个起始 block
        const maxStart = Math.max(0, pathLength - blockSize);
        const startIdx = Math.floor(random() * (maxStart + 1));
        const blockLen = Math.min(blockSize, pathLength - daysGenerated);

        for (let b = 0; b < blockLen; b++) {
          const ret = dailyReturns[startIdx + b] ?? 0;
          currentEquity *= 1 + ret;
          if (currentEquity <= 0) currentEquity = 0.01;

          if (currentEquity > peak) {
            peak = currentEquity;
          }
          const dd = peak > 0 ? (peak - currentEquity) / peak : 0;
          if (dd > maxDD) maxDD = dd;

          if (currentEquity <= ruinThreshold) {
            hasRuined = true;
          }

          simPath.push(currentEquity);
          daysGenerated++;
          if (daysGenerated >= pathLength) break;
        }
      }

      if (hasRuined) ruinCount++;
      allPaths.push(simPath);

      const finalEquity = simPath[simPath.length - 1]!;
      const totalReturn = (finalEquity - initialCapital) / initialCapital;
      const years = Math.max(0.01, pathLength / 252);
      const cagr = finalEquity > 0 ? Math.pow(finalEquity / initialCapital, 1 / years) - 1 : -1;

      // 计算简易 Sharpe
      const simReturns: number[] = [];
      for (let k = 1; k < simPath.length; k++) {
        const p = simPath[k - 1]!;
        const c = simPath[k]!;
        simReturns.push(p > 0 ? (c - p) / p : 0);
      }
      const meanR = simReturns.reduce((a, b) => a + b, 0) / Math.max(1, simReturns.length);
      const variance =
        simReturns.reduce((a, b) => a + Math.pow(b - meanR, 2), 0) / Math.max(1, simReturns.length);
      const stdR = Math.sqrt(variance);
      const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

      simTotalReturns.push(totalReturn);
      simMaxDrawdowns.push(maxDD);
      simCAGRs.push(cagr);
      simSharpes.push(sharpe);
    }

    // 3. 计算分位数分布
    const totalReturnPercentiles = computePercentiles(simTotalReturns);
    const maxDrawdownPercentiles = computePercentiles(simMaxDrawdowns);
    const cagrPercentiles = computePercentiles(simCAGRs);
    const sharpePercentiles = computePercentiles(simSharpes);

    const probabilityOfRuin = Number((ruinCount / simulations).toFixed(4));

    // 4. 稳健度评级与评分
    let drawdownRiskRating: MonteCarloSimulationResult["drawdownRiskRating"] = "low";
    if (maxDrawdownPercentiles.p95 > 0.45 || probabilityOfRuin > 0.1) {
      drawdownRiskRating = "critical";
    } else if (maxDrawdownPercentiles.p95 > 0.3 || probabilityOfRuin > 0.05) {
      drawdownRiskRating = "high";
    } else if (maxDrawdownPercentiles.p95 > 0.2) {
      drawdownRiskRating = "moderate";
    }

    // 综合压力评分：考虑 p5 最坏收益、95% 最坏回撤与破产概率
    const stressScore = Number(
      Math.max(
        0.05,
        Math.min(
          1.0,
          1 - maxDrawdownPercentiles.p95 * 0.8 - probabilityOfRuin * 1.5 + Math.max(0, totalReturnPercentiles.median) * 0.2
        )
      ).toFixed(3)
    );

    // 5. 提取代表性净值曲线 (p5, median, p95)
    const simulatedPathsSummary: MonteCarloRepresentativePath[] = [];
    for (let d = 0; d <= pathLength; d++) {
      const dayValues = allPaths.map((p) => p[d] ?? initialCapital).sort((a, b) => a - b);
      const date = d === 0 ? equityCurve[0]!.date : equityCurve[d - 1]!.date;
      simulatedPathsSummary.push({
        date,
        p5Worst: Math.round(dayValues[Math.floor(dayValues.length * 0.05)] ?? initialCapital),
        median: Math.round(dayValues[Math.floor(dayValues.length * 0.5)] ?? initialCapital),
        p95Best: Math.round(dayValues[Math.floor(dayValues.length * 0.95)] ?? initialCapital),
      });
    }

    return {
      backtestJobId: sourceJob.id,
      simulationCount: simulations,
      initialCapital,
      metrics: {
        totalReturnPercentiles,
        maxDrawdownPercentiles,
        cagrPercentiles,
        sharpePercentiles,
      },
      probabilityOfRuin,
      stressScore,
      drawdownRiskRating,
      simulatedPathsSummary,
      meta: {
        sampleDays: pathLength,
        seed,
        latencyMs: Date.now() - t0,
      },
    };
  }
}

export function normalizeSeed(value: number | string): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value) >>> 0;
  const digest = createHash("sha256").update(String(value)).digest();
  return digest.readUInt32LE(0);
}

/** Small deterministic PRNG suitable for reproducible bootstrap sampling, not cryptography. */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function computePercentiles(values: number[]): MonteCarloPercentileMetric {
  if (values.length === 0) {
    return { p5: 0, p25: 0, median: 0, p75: 0, p95: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    p5: Number((sorted[Math.floor(n * 0.05)] ?? 0).toFixed(4)),
    p25: Number((sorted[Math.floor(n * 0.25)] ?? 0).toFixed(4)),
    median: Number((sorted[Math.floor(n * 0.5)] ?? 0).toFixed(4)),
    p75: Number((sorted[Math.floor(n * 0.75)] ?? 0).toFixed(4)),
    p95: Number((sorted[Math.floor(n * 0.95)] ?? 0).toFixed(4)),
  };
}

export const monteCarloService = new MonteCarloService();
