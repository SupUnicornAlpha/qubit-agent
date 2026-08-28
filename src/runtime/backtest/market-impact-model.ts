/**
 * 市场微观结构与高精细滑点冲击模型（Market Impact & Microstructure Engine）
 *
 * 支持：
 * 1. 固定基点滑点（Fixed Bps）
 * 2. 平方根冲击模型（Square-Root Impact Model / Almgren-Chriss 简化）:
 *    Impact = baseSlip + gamma * sigma * sqrt(OrderQty / BarVolume)
 * 3. 波动率自适应滑点（Volatility-Adjusted Slippage）
 * 4. 单根 Bar 最大成交量参与率上限（Max Volume Participation Rate Limit）
 * 5. 融券借券利率年化计提（Borrow Rate / Margin Interest）与借券池限制
 */

export type ImpactModelKind = "fixed_bps" | "square_root" | "volatility_adjusted";

export interface MarketImpactConfig {
  model?: ImpactModelKind;
  /** 基础滑点基点（1bp = 0.0001 = 0.01%） */
  baseSlippageBps: number;
  /** 平方根模型冲击系数 gamma（默认 0.1） */
  impactCoefficient?: number;
  /** 波动率敏感系数 alpha（默认 1.0） */
  volatilitySensitivity?: number;
  /** 最大成交量参与率（如 0.10 表示单笔最多成交当根 Bar 成交量的 10%） */
  maxVolumeParticipation?: number;
  /** 做空借券年化利率基点（如 200bps = 2% 年化） */
  borrowRateAnnualBps?: number;
  /** 受限不可做空/借券池耗尽的标的列表 */
  restrictedShortSymbols?: string[];
}

export interface SlippageCalculationInput {
  symbol: string;
  side: "buy" | "sell";
  nominalPrice: number;
  qty: number;
  bar: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  config: MarketImpactConfig;
  /** 历史日波动率估计（可选，若无则由当前 Bar (H-L)/O 估算） */
  estimatedDailyVol?: number;
}

export interface SlippageCalculationResult {
  effectivePrice: number;
  slippageRate: number; // 小数，如 0.0005
  impactBps: number; // 基点
  actualFilledQty: number; // 考虑流动性参与率限制后的实际可成交量
  unfilledQty: number; // 因流动性限制未成交量
  liquidityCapped: boolean;
}

export function calculateExecutionImpact(
  input: SlippageCalculationInput
): SlippageCalculationResult {
  const { nominalPrice, qty, bar, config, side } = input;
  const model = config.model ?? "fixed_bps";
  const baseRate = Math.max(0, config.baseSlippageBps) / 10_000;

  // 1. 流动性参与率上限截断
  let actualFilledQty = qty;
  let unfilledQty = 0;
  let liquidityCapped = false;

  if (config.maxVolumeParticipation && config.maxVolumeParticipation > 0 && bar.volume > 0) {
    const maxAllowedQty = bar.volume * config.maxVolumeParticipation;
    if (qty > maxAllowedQty) {
      actualFilledQty = maxAllowedQty;
      unfilledQty = qty - maxAllowedQty;
      liquidityCapped = true;
    }
  }

  // 2. 根据冲击模型计算总滑点率
  let effectiveSlippageRate = baseRate;

  if (model === "square_root") {
    const gamma = config.impactCoefficient ?? 0.1;
    const barVolume = Math.max(1, bar.volume);
    const participationRatio = Math.min(1.0, actualFilledQty / barVolume);
    // 估计波动率
    const barRangeVol = bar.open > 0 ? (bar.high - bar.low) / bar.open : 0.02;
    const sigma = input.estimatedDailyVol ?? Math.max(0.005, barRangeVol);
    const impact = gamma * sigma * Math.sqrt(participationRatio);
    effectiveSlippageRate = baseRate + impact;
  } else if (model === "volatility_adjusted") {
    const alpha = config.volatilitySensitivity ?? 1.0;
    const barRange = bar.open > 0 ? (bar.high - bar.low) / bar.open : 0.02;
    // 波动率越大，滑点越高
    effectiveSlippageRate = baseRate * (1 + alpha * (barRange / 0.02));
  }

  // 3. 计算实际成交价格（买入价上浮，卖出价下折）
  const multiplier = side === "buy" ? 1 + effectiveSlippageRate : 1 - effectiveSlippageRate;
  const effectivePrice = Math.max(0.0001, nominalPrice * multiplier);
  const impactBps = Number((effectiveSlippageRate * 10_000).toFixed(2));

  return {
    effectivePrice,
    slippageRate: effectiveSlippageRate,
    impactBps,
    actualFilledQty,
    unfilledQty,
    liquidityCapped,
  };
}

/**
 * 借券与融券每日利息计提计算
 */
export function calculateDailyBorrowCost(
  shortPositionsNotional: number,
  borrowRateAnnualBps: number = 0,
  daysCount: number = 1
): number {
  if (shortPositionsNotional <= 0 || borrowRateAnnualBps <= 0) return 0;
  const annualRate = borrowRateAnnualBps / 10_000;
  const dailyRate = annualRate / 365;
  return shortPositionsNotional * dailyRate * daysCount;
}
