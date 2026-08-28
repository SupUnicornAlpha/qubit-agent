/**
 * 回测参数敏感性分析服务（Parameter Sensitivity & Heatmap Service）
 *
 * 核心功能：
 * 1. 支持在多维参数网格（TopN、佣金手续费、滑点冲击、调仓频率等）执行笛卡尔积快速扫描
 * 2. 计算 Sharpe / CAGR / MaxDrawdown / Calmar 的敏感性矩阵与 2D 热力图
 * 3. 评估参数平原（Parameter Plateau）与参数悬崖（Overfitting Cliff），输出稳健性评分
 */

import { backtestJobService } from "./backtest-job-service";
import { providerResolver } from "../provider/resolver";
import type {
  BacktestCosts,
  BacktestProvider,
  BacktestRequest,
  BacktestResult,
} from "../provider/types";

export type SensitivityParamKey = "topN" | "commissionBps" | "slippageBps" | "rebalance" | "capital";

export interface SensitivityDimension {
  key: SensitivityParamKey;
  label: string;
  values: Array<number | string>;
}

export interface SensitivityGridCell {
  xIndex: number;
  yIndex: number;
  xValue: number | string;
  yValue: number | string;
  sharpe: number;
  maxDrawdown: number;
  annualReturn: number;
  totalReturn: number;
  calmar: number;
  turnover: number;
  compositeScore: number;
}

export interface SensitivityAnalysisResult {
  backtestJobId: string;
  /** Full-window grid selection is exploratory and cannot be deployment evidence. */
  useClass: "research_only";
  parameterSelection: "full_sample_optimized";
  integrityWarning: string;
  xDimension: SensitivityDimension;
  yDimension: SensitivityDimension;
  grid: SensitivityGridCell[][];
  optimal: {
    xValue: number | string;
    yValue: number | string;
    metrics: {
      sharpe: number;
      maxDrawdown: number;
      annualReturn: number;
      calmar: number;
    };
  };
  stabilityScore: number; // 0 ~ 1.0 稳健度评分，越平缓抗过拟合能力越强
  parameterCliffDetected: boolean;
  meta: {
    totalEvaluations: number;
    latencyMs: number;
  };
}

export interface RunSensitivityInput {
  jobId: string;
  xParam?: {
    key: SensitivityParamKey;
    values: Array<number | string>;
  };
  yParam?: {
    key: SensitivityParamKey;
    values: Array<number | string>;
  };
}

export class SensitivityAnalysisService {
  async run(input: RunSensitivityInput): Promise<SensitivityAnalysisResult> {
    const t0 = Date.now();
    const sourceJob = await backtestJobService.get(input.jobId);
    if (!sourceJob) {
      throw new Error(`Backtest job not found: ${input.jobId}`);
    }

    const provider = await providerResolver.resolve<"backtest">(
      "backtest",
      {},
      { providerKey: sourceJob.engineKey }
    );
    const runner = provider as BacktestProvider;
    if (!runner.run) {
      throw new Error(`Provider ${sourceJob.engineKey} lacks run method`);
    }

    // 默认扫描维度
    const xDim: SensitivityDimension = {
      key: input.xParam?.key ?? "slippageBps",
      label: input.xParam?.key === "topN" ? "TopN 选股数" : "滑点基点 (Bps)",
      values: input.xParam?.values ?? [2, 5, 10, 15, 20],
    };

    const yDim: SensitivityDimension = {
      key: input.yParam?.key ?? "topN",
      label: input.yParam?.key === "commissionBps" ? "手续费 (Bps)" : "TopN 选股数",
      values: input.yParam?.values ?? [1, 2, 3, 5],
    };
    validateDimension(xDim);
    validateDimension(yDim);
    if (xDim.values.length * yDim.values.length > 100) {
      throw new Error("sensitivity_grid_too_large: maximum 100 evaluations");
    }

    const grid: SensitivityGridCell[][] = [];
    let bestCell: SensitivityGridCell | null = null;
    let totalScore = 0;
    const scores: number[] = [];

    for (let yi = 0; yi < yDim.values.length; yi++) {
      const row: SensitivityGridCell[] = [];
      const yVal = yDim.values[yi]!;

      for (let xi = 0; xi < xDim.values.length; xi++) {
        const xVal = xDim.values[xi]!;

        // 构造覆盖配置
        const runConfig: BacktestRequest = {
          ...sourceJob.config,
          costs: {
            ...sourceJob.config.costs,
          } as BacktestCosts,
          // This grid uses the same evaluation window to select an optimum. Every cell is
          // explicitly rejected as validation evidence by the anti-leakage report.
          experiment: { parameterSelection: "full_sample_optimized" },
        };

        applyParamValue(runConfig, xDim.key, xVal);
        applyParamValue(runConfig, yDim.key, yVal);

        const result: BacktestResult = await runner.run(runConfig);
        const m = result.metrics;

        const sharpe = Number(m.sharpe.toFixed(3));
        const maxDrawdown = Number(m.maxDrawdown.toFixed(4));
        const annualReturn = Number(m.annualReturn.toFixed(4));
        const totalReturn = Number(m.totalReturn.toFixed(4));
        const calmar = Number((m.calmar ?? 0).toFixed(3));
        const turnover = Number(m.turnover.toFixed(2));

        // 复合评价分（收益风险均衡）
        const compositeScore = Number(
          (sharpe * 0.4 + calmar * 0.3 + annualReturn * 2 - maxDrawdown * 1.5).toFixed(3)
        );

        const cell: SensitivityGridCell = {
          xIndex: xi,
          yIndex: yi,
          xValue: xVal,
          yValue: yVal,
          sharpe,
          maxDrawdown,
          annualReturn,
          totalReturn,
          calmar,
          turnover,
          compositeScore,
        };

        row.push(cell);
        scores.push(compositeScore);
        totalScore += compositeScore;

        if (!bestCell || compositeScore > bestCell.compositeScore) {
          bestCell = cell;
        }
      }
      grid.push(row);
    }

    // 计算参数稳定性与悬崖效应（变异系数 CV 与邻域突变）
    const meanScore = scores.length > 0 ? totalScore / scores.length : 0;
    const variance =
      scores.reduce((sum, s) => sum + Math.pow(s - meanScore, 2), 0) / Math.max(1, scores.length);
    const stdDev = Math.sqrt(variance);
    const cv = Math.abs(meanScore) > 0.001 ? stdDev / Math.abs(meanScore) : 1;

    // 变异适中代表平原稳定，极端大代表悬崖过拟合
    const stabilityScore = Number(Math.max(0.1, Math.min(1.0, 1 / (1 + cv * 0.5))).toFixed(3));
    const parameterCliffDetected = cv > 1.5;

    return {
      backtestJobId: sourceJob.id,
      useClass: "research_only",
      parameterSelection: "full_sample_optimized",
      integrityWarning:
        "Grid optimum was selected on the evaluation window; freeze a candidate and run independent purged OOS validation.",
      xDimension: xDim,
      yDimension: yDim,
      grid,
      optimal: {
        xValue: bestCell?.xValue ?? xDim.values[0]!,
        yValue: bestCell?.yValue ?? yDim.values[0]!,
        metrics: {
          sharpe: bestCell?.sharpe ?? 0,
          maxDrawdown: bestCell?.maxDrawdown ?? 0,
          annualReturn: bestCell?.annualReturn ?? 0,
          calmar: bestCell?.calmar ?? 0,
        },
      },
      stabilityScore,
      parameterCliffDetected,
      meta: {
        totalEvaluations: xDim.values.length * yDim.values.length,
        latencyMs: Date.now() - t0,
      },
    };
  }
}

function validateDimension(dimension: SensitivityDimension): void {
  if (dimension.values.length === 0 || dimension.values.length > 20) {
    throw new Error(`invalid_sensitivity_dimension_size: ${dimension.key}`);
  }
  for (const value of dimension.values) {
    if (dimension.key === "rebalance") {
      if (value !== "daily" && value !== "weekly" && value !== "monthly") {
        throw new Error(`invalid_sensitivity_value: ${dimension.key}=${String(value)}`);
      }
      continue;
    }
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new Error(`invalid_sensitivity_value: ${dimension.key}=${String(value)}`);
    }
  }
}

function applyParamValue(config: BacktestRequest, key: SensitivityParamKey, val: number | string) {
  if (key === "topN") {
    config.topN = typeof val === "number" ? val : parseInt(String(val), 10);
  } else if (key === "commissionBps") {
    config.costs.commissionBps = typeof val === "number" ? val : parseFloat(String(val));
  } else if (key === "slippageBps") {
    config.costs.slippageBps = typeof val === "number" ? val : parseFloat(String(val));
  } else if (key === "rebalance") {
    config.rebalance = String(val) as "daily" | "weekly" | "monthly";
  } else if (key === "capital") {
    config.capital = typeof val === "number" ? val : parseFloat(String(val));
  }
}

export const sensitivityAnalysisService = new SensitivityAnalysisService();
