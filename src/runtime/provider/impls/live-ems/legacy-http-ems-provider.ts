/**
 * 内置 fallback：legacy_http LiveEmsProvider
 *
 * 把现有 `python_connectors/broker_http_server.py`（Futu / IB / CCXT）包装成 Provider。
 * execution-dispatcher 不再直接 import broker connector，统一走 Resolver。
 * P4 阶段会加 veighna LiveEmsProvider 作为主 Provider，本 Provider 作为降级使用。
 */

import {
  type LiveEmsProvider,
  type ProviderMeta,
} from "../../types";

const META: ProviderMeta = {
  kind: "live_ems",
  key: "legacy_http",
  displayName: "Legacy HTTP Broker（内置 fallback）",
  description: "通过 python_connectors/broker_http_server.py 接 Futu/IB/CCXT；HTTP 同步下单。",
  version: "0.1.0",
  capability: {
    features: ["http_order", "polling_fills", "broker_futu", "broker_ib", "broker_ccxt"],
    performanceProfile: "neartime",
  },
  isBuiltin: true,
  isFallback: true,
};

export class LegacyHttpEmsProvider implements LiveEmsProvider {
  readonly meta = META;

  async healthCheck(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}
