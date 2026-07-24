/**
 * 经纪 / 交易适配的共享类型定义。
 *
 * 历史：此文件原本在 `src/runtime/reia/broker-types.ts`，但被 `market`、`execution`、
 * `mcp` 三个非 reia 层反向引用，破坏分层（数据层不该认识"哪些券商类型存在"）。
 * 本轮架构盘点 (P0-H) 把它挪到中性的 `src/types/`，让上层模块都从这里读。
 *
 * 注：仅类型；运行时实现（broker-connector / broker-service / broker-admin）仍在
 * `runtime/reia/`，未来 P2 阶段可考虑迁移到 `runtime/execution/broker/`。
 */

export const BROKER_PROVIDERS = [
  "futu",
  "ib",
  "ccxt",
  "alpaca",
  "supermind",
  "eastmoney_emt",
] as const;

export type BrokerProvider = (typeof BROKER_PROVIDERS)[number];

export function isBrokerProvider(value: unknown): value is BrokerProvider {
  return typeof value === "string" && BROKER_PROVIDERS.includes(value as BrokerProvider);
}

export type FutuProviderConfig = {
  opendHost?: string;
  opendPort?: number;
  market?: "HK" | "US" | "CN";
  accId?: string;
};

export type IbProviderConfig = {
  host?: string;
  port?: number;
  clientId?: number;
  accountId?: string;
};

export type CcxtProviderConfig = {
  exchangeId?: string;
  apiKeyRef?: string;
  sandbox?: boolean;
  defaultType?: "spot" | "future";
  market?: "CRYPTO";
};

/**
 * Alpaca paper / live trading（美股）。注册即用，无身份证要求。
 * - paper: https://paper-api.alpaca.markets
 * - live:  https://api.alpaca.markets
 *
 * 凭据走 env（apiKeyEnv / secretEnv 默认 ALPACA_API_KEY_ID / ALPACA_API_SECRET），
 * 或直接由 broker_account 的 provider_config_json 注入 apiKey/apiSecret（不推荐，敏感数据应在 env）。
 */
export type AlpacaProviderConfig = {
  baseUrl?: string;
  apiKeyEnv?: string;
  secretEnv?: string;
  market?: "US";
};

export type SuperMindProviderConfig = {
  accountId?: string;
  marketPriceType?: number;
  limitPriceType?: number;
  market?: "CN";
};

export type EastmoneyEmtProviderConfig = {
  connectionSetting?: Record<string, unknown>;
  connectionSettingEnv?: string;
  connectWaitSeconds?: number;
  market?: "CN";
};

export type BrokerProviderConfig =
  | FutuProviderConfig
  | IbProviderConfig
  | CcxtProviderConfig
  | AlpacaProviderConfig
  | SuperMindProviderConfig
  | EastmoneyEmtProviderConfig;

export type BrokerAccountRow = {
  id: string;
  provider: BrokerProvider;
  accountRef: string;
  mode: "mock" | "sandbox" | "live";
  baseUrl: string | null;
  providerConfigJson: BrokerProviderConfig;
  isDefault: boolean;
  enabled: boolean;
};
