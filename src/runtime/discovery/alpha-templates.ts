/**
 * Alpha101 / 经典量化因子模板（精选 12 个最常用 + 健壮）
 *
 * 这些表达式都能直接被 qlib_expr 引擎求值。
 * 灵感来源：WorldQuant Alpha101 / Qlib Alpha158 / 主流文献。
 */

export interface AlphaTemplate {
  /** 短 ID，写入 discovery output */
  id: string;
  /** 中文描述 */
  description: string;
  /** Qlib-like 表达式 */
  expr: string;
  /** 推荐 horizon 天数 */
  horizon: number;
  /** 因子分类 */
  category: "momentum" | "value" | "volatility" | "quality" | "macro" | "news";
}

export const ALPHA_TEMPLATES: AlphaTemplate[] = [
  {
    id: "mom_5",
    description: "5 日动量",
    expr: "close / Ref(close, 5) - 1",
    horizon: 5,
    category: "momentum",
  },
  {
    id: "mom_20",
    description: "20 日动量",
    expr: "close / Ref(close, 20) - 1",
    horizon: 5,
    category: "momentum",
  },
  {
    id: "rev_1",
    description: "1 日反转（短期）",
    expr: "-1 * (close / Ref(close, 1) - 1)",
    horizon: 1,
    category: "momentum",
  },
  {
    id: "ma_cross_z",
    description: "5/20 均线差 Z-score",
    expr: "(Mean(close, 5) - Mean(close, 20)) / Std(close, 20)",
    horizon: 5,
    category: "momentum",
  },
  {
    id: "vol_20",
    description: "20 日波动率",
    expr: "Std(close / Ref(close, 1) - 1, 20)",
    horizon: 5,
    category: "volatility",
  },
  {
    id: "ivol_inv_20",
    description: "低波动反向（1 / vol20）",
    expr: "1 / (Std(close / Ref(close, 1) - 1, 20) + 0.001)",
    horizon: 5,
    category: "volatility",
  },
  {
    id: "vp_corr_10",
    description: "10 日量价相关",
    expr: "Corr(close, volume, 10)",
    horizon: 5,
    category: "quality",
  },
  {
    id: "neg_vp_corr_10",
    description: "10 日量价负相关",
    expr: "-1 * Corr(close, volume, 10)",
    horizon: 5,
    category: "quality",
  },
  {
    id: "slope_20",
    description: "20 日价格斜率",
    expr: "Slope(close, 20)",
    horizon: 10,
    category: "momentum",
  },
  {
    id: "high_low_pct",
    description: "20 日高低位置",
    expr: "(close - Min(low, 20)) / (Max(high, 20) - Min(low, 20) + 0.001)",
    horizon: 5,
    category: "momentum",
  },
  {
    id: "vol_zscore_20",
    description: "20 日成交量 Z-score",
    expr: "(volume - Mean(volume, 20)) / (Std(volume, 20) + 0.001)",
    horizon: 3,
    category: "quality",
  },
  {
    id: "log_ret_5",
    description: "5 日对数收益",
    expr: "Log(close) - Log(Ref(close, 5))",
    horizon: 5,
    category: "momentum",
  },
];
