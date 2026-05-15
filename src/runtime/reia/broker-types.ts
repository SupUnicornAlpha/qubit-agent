export type BrokerProvider = "futu" | "ib";

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

export type BrokerProviderConfig = FutuProviderConfig | IbProviderConfig;

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
