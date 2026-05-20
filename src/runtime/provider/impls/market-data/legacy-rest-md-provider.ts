/**
 * 内置 fallback：legacy_rest MarketDataProvider
 *
 * 把现有 `src/runtime/market/klines-data-source.ts`（多源 K 线路由）包装成 Provider。
 * P4 阶段会加 veighna_md 作为主 Provider，本 Provider 作为降级使用。
 */

import { type MarketDataProvider, type ProviderMeta } from "../../types";

const META: ProviderMeta = {
  kind: "market_data",
  key: "legacy_rest",
  displayName: "Legacy REST K-line（内置 fallback）",
  description:
    "通过 klines-data-source 多源路由（东财/AkShare/Yahoo/Binance/Tushare）拉日线 K 线。",
  version: "0.1.0",
  capability: {
    supportedAssetClasses: ["stock", "crypto"],
    features: ["bar_query", "multi_source", "rest_pull"],
    performanceProfile: "batch",
  },
  isBuiltin: true,
  isFallback: true,
};

export class LegacyRestMarketDataProvider implements MarketDataProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
