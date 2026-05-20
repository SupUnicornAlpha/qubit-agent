/**
 * 内置 fallback：sma_legacy BacktestProvider
 *
 * 把现有 `src/runtime/market/backtest-engine.ts` 的 SMA crossover 包装成 Provider。
 * 这样业务侧不再直接 import runSmaCrossoverBacktest，统一走 ProviderResolver。
 * P2 阶段会加 backtrader / veighna_bt 作为主 Provider，本 Provider 留作降级使用。
 */

import {
  type BacktestProvider,
  type ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "backtest",
  key: "sma_legacy",
  displayName: "SMA Legacy（内置 fallback）",
  description: "单股 SMA 交叉、bar-by-bar 简化回测，保留作 fallback。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "crypto"],
    features: ["single_symbol", "bar_by_bar", "long_only"],
    performanceProfile: "batch",
  },
  isBuiltin: true,
  isFallback: true,
};

export class SmaLegacyBacktestProvider implements BacktestProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
