import { randomUUID } from "node:crypto";
import type { BrokerProvider, BrokerProviderConfig } from "./broker-types";

export type {
  BrokerProvider,
  BrokerProviderConfig,
  CcxtProviderConfig,
  FutuProviderConfig,
  IbProviderConfig,
} from "./broker-types";

export type BrokerOrderSide = "buy" | "sell";
export type BrokerOrderType = "market" | "limit";
export type BrokerOrderStatus = "submitted" | "filled" | "rejected" | "cancelled";

export interface BrokerSubmitOrderInput {
  ticker: string;
  side: BrokerOrderSide;
  quantity: number;
  orderType: BrokerOrderType;
  limitPrice?: number;
}

export interface BrokerOrderResult {
  provider: BrokerProvider;
  brokerOrderId: string;
  status: BrokerOrderStatus;
  actualPrice: number;
  actualQuantity: number;
  executionTimeMs: number;
  raw?: Record<string, unknown>;
}

export interface BrokerFill {
  brokerOrderId: string;
  fillQty: number;
  fillPrice: number;
  filledAt: string;
}

export interface BrokerPosition {
  symbol: string;
  qty: number;
  avgPrice: number;
  market?: string;
}

export interface BrokerHealthResult {
  provider: BrokerProvider;
  status: "healthy" | "degraded" | "down";
  message: string;
  checkedAt: string;
  latencyMs?: number;
  accountRef?: string;
}

export interface BrokerRuntimeConfig {
  provider: BrokerProvider;
  mode: "mock" | "sandbox" | "live";
  accountRef: string;
  baseUrl?: string;
  providerConfig?: BrokerProviderConfig;
  paper?: boolean;
}

export interface BrokerConnector {
  readonly provider: BrokerProvider;
  readonly mode: "mock" | "sandbox" | "live";
  readonly accountRef: string;
  submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult>;
  cancelOrder(brokerOrderId: string): Promise<void>;
  getOrder(brokerOrderId: string): Promise<BrokerOrderResult>;
  getFills(brokerOrderId: string): Promise<BrokerFill[]>;
  getPositions(): Promise<BrokerPosition[]>;
  healthCheck(): Promise<BrokerHealthResult>;
}

function paperFromMode(mode: BrokerRuntimeConfig["mode"], explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  if (mode === "sandbox") return true;
  if (mode === "live") return false;
  return true;
}

function httpBodyBase(config: BrokerRuntimeConfig): Record<string, unknown> {
  return {
    provider: config.provider,
    accountRef: config.accountRef,
    paper: paperFromMode(config.mode, config.paper),
    providerConfig: config.providerConfig ?? {},
  };
}

class MockFutuConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "futu";
  readonly mode = "mock" as const;
  readonly accountRef: string;

  constructor(accountRef = "futu-mock") {
    this.accountRef = accountRef;
  }

  async submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult> {
    const latency = Math.floor(80 + Math.random() * 260);
    const base = input.limitPrice ?? 100;
    const slipPct = (Math.random() - 0.5) * 0.006;
    const price = Number((base * (1 + slipPct)).toFixed(4));
    return {
      provider: this.provider,
      brokerOrderId: `futu-${Date.now()}-${randomUUID().slice(0, 8)}`,
      status: "filled",
      actualPrice: price,
      actualQuantity: input.quantity,
      executionTimeMs: latency,
      raw: { venue: "MOCK_FUTU", ticker: input.ticker },
    };
  }

  async cancelOrder(_brokerOrderId: string): Promise<void> {
    /* mock no-op */
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    return {
      provider: this.provider,
      brokerOrderId,
      status: "filled",
      actualPrice: 100,
      actualQuantity: 0,
      executionTimeMs: 1,
      raw: { venue: "MOCK_FUTU" },
    };
  }

  async getFills(brokerOrderId: string): Promise<BrokerFill[]> {
    return [
      {
        brokerOrderId,
        fillQty: 100,
        fillPrice: 100,
        filledAt: new Date().toISOString(),
      },
    ];
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [];
  }

  async healthCheck(): Promise<BrokerHealthResult> {
    return {
      provider: this.provider,
      status: "healthy",
      message: "mock connector ready",
      checkedAt: new Date().toISOString(),
      latencyMs: Math.floor(20 + Math.random() * 25),
      accountRef: this.accountRef,
    };
  }
}

class MockCcxtConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "ccxt";
  readonly mode = "mock" as const;
  readonly accountRef: string;

  constructor(accountRef = "ccxt-mock") {
    this.accountRef = accountRef;
  }

  async submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult> {
    const latency = Math.floor(60 + Math.random() * 200);
    const base = input.limitPrice ?? 100;
    const slipPct = (Math.random() - 0.5) * 0.01;
    const price = Number((base * (1 + slipPct)).toFixed(4));
    return {
      provider: this.provider,
      brokerOrderId: `ccxt-${Date.now()}-${randomUUID().slice(0, 8)}`,
      status: "filled",
      actualPrice: price,
      actualQuantity: input.quantity,
      executionTimeMs: latency,
      raw: { venue: "MOCK_CCXT", ticker: input.ticker },
    };
  }

  async cancelOrder(_brokerOrderId: string): Promise<void> {}

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    return {
      provider: this.provider,
      brokerOrderId,
      status: "filled",
      actualPrice: 100,
      actualQuantity: 1,
      executionTimeMs: 0,
    };
  }

  async getFills(brokerOrderId: string): Promise<BrokerFill[]> {
    return [
      {
        brokerOrderId,
        fillQty: 1,
        fillPrice: 100,
        filledAt: new Date().toISOString(),
      },
    ];
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [];
  }

  async healthCheck(): Promise<BrokerHealthResult> {
    return {
      provider: this.provider,
      status: "healthy",
      message: "mock ccxt ready",
      checkedAt: new Date().toISOString(),
      latencyMs: 20,
      accountRef: this.accountRef,
    };
  }
}

class MockIbConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "ib";
  readonly mode = "mock" as const;
  readonly accountRef: string;

  constructor(accountRef = "ib-mock") {
    this.accountRef = accountRef;
  }

  async submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult> {
    const latency = Math.floor(120 + Math.random() * 320);
    const base = input.limitPrice ?? 100;
    const slipPct = (Math.random() - 0.5) * 0.008;
    const qtySlipPct = (Math.random() - 0.5) * 0.02;
    const price = Number((base * (1 + slipPct)).toFixed(4));
    const qty = Number((input.quantity * (1 + qtySlipPct)).toFixed(4));
    return {
      provider: this.provider,
      brokerOrderId: `ib-${Date.now()}-${randomUUID().slice(0, 8)}`,
      status: "filled",
      actualPrice: price,
      actualQuantity: qty,
      executionTimeMs: latency,
      raw: { venue: "MOCK_IB", ticker: input.ticker },
    };
  }

  async cancelOrder(_brokerOrderId: string): Promise<void> {
    /* mock no-op */
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    return {
      provider: this.provider,
      brokerOrderId,
      status: "filled",
      actualPrice: 100,
      actualQuantity: 0,
      executionTimeMs: 1,
      raw: { venue: "MOCK_IB" },
    };
  }

  async getFills(brokerOrderId: string): Promise<BrokerFill[]> {
    return [
      {
        brokerOrderId,
        fillQty: 100,
        fillPrice: 100,
        filledAt: new Date().toISOString(),
      },
    ];
  }

  async getPositions(): Promise<BrokerPosition[]> {
    return [];
  }

  async healthCheck(): Promise<BrokerHealthResult> {
    return {
      provider: this.provider,
      status: "healthy",
      message: "mock connector ready",
      checkedAt: new Date().toISOString(),
      latencyMs: Math.floor(25 + Math.random() * 30),
      accountRef: this.accountRef,
    };
  }
}

class HttpBrokerConnector implements BrokerConnector {
  readonly provider: BrokerProvider;
  readonly mode: "sandbox" | "live";
  readonly accountRef: string;
  private readonly baseUrl: string;
  private readonly runtime: BrokerRuntimeConfig;

  constructor(runtime: BrokerRuntimeConfig & { baseUrl: string }) {
    this.provider = runtime.provider;
    this.mode = runtime.mode as "sandbox" | "live";
    this.accountRef = runtime.accountRef;
    this.baseUrl = runtime.baseUrl.replace(/\/$/, "");
    this.runtime = runtime;
  }

  private async requestJson(
    method: string,
    path: string,
    body?: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`broker ${method} ${path} failed: ${res.status} ${JSON.stringify(payload)}`);
    return payload;
  }

  async submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult> {
    const started = Date.now();
    const payload = await this.requestJson("POST", "/orders", {
      ...input,
      ...httpBodyBase(this.runtime),
    });
    return {
      provider: this.provider,
      brokerOrderId: String(payload.brokerOrderId ?? `${this.provider}-${Date.now()}-${randomUUID().slice(0, 8)}`),
      status: (payload.status as BrokerOrderStatus | undefined) ?? "submitted",
      actualPrice: Number(payload.actualPrice ?? input.limitPrice ?? 0),
      actualQuantity: Number(payload.actualQuantity ?? input.quantity),
      executionTimeMs: Date.now() - started,
      raw: payload,
    };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.requestJson("POST", "/orders/cancel", {
      brokerOrderId,
      ...httpBodyBase(this.runtime),
    });
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderResult> {
    const qs = new URLSearchParams({
      provider: this.provider,
      accountRef: this.accountRef,
      brokerOrderId,
    });
    const payload = await this.requestJson("GET", `/orders?${qs.toString()}`);
    return {
      provider: this.provider,
      brokerOrderId: String(payload.brokerOrderId ?? brokerOrderId),
      status: (payload.status as BrokerOrderStatus | undefined) ?? "submitted",
      actualPrice: Number(payload.actualPrice ?? 0),
      actualQuantity: Number(payload.actualQuantity ?? 0),
      executionTimeMs: Number(payload.executionTimeMs ?? 0),
      raw: payload,
    };
  }

  async getFills(brokerOrderId: string): Promise<BrokerFill[]> {
    const qs = new URLSearchParams({
      provider: this.provider,
      accountRef: this.accountRef,
      brokerOrderId,
    });
    const payload = await this.requestJson("GET", `/fills?${qs.toString()}`);
    const fills = payload.fills;
    if (!Array.isArray(fills)) return [];
    return fills.map((f) => {
      const row = f as Record<string, unknown>;
      return {
        brokerOrderId: String(row.brokerOrderId ?? brokerOrderId),
        fillQty: Number(row.fillQty ?? 0),
        fillPrice: Number(row.fillPrice ?? 0),
        filledAt: String(row.filledAt ?? new Date().toISOString()),
      };
    });
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const qs = new URLSearchParams({
      provider: this.provider,
      accountRef: this.accountRef,
    });
    const payload = await this.requestJson("GET", `/positions?${qs.toString()}`);
    const positions = payload.positions;
    if (!Array.isArray(positions)) return [];
    return positions.map((p) => {
      const row = p as Record<string, unknown>;
      return {
        symbol: String(row.symbol ?? ""),
        qty: Number(row.qty ?? 0),
        avgPrice: Number(row.avgPrice ?? 0),
        market: row.market != null ? String(row.market) : undefined,
      };
    });
  }

  async healthCheck(): Promise<BrokerHealthResult> {
    const started = Date.now();
    try {
      const cfg = this.runtime.providerConfig ?? {};
      const qs = new URLSearchParams({
        provider: this.provider,
        accountRef: this.accountRef,
        providerConfig: JSON.stringify(cfg),
      });
      const res = await fetch(`${this.baseUrl}/health?${qs.toString()}`);
      const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          provider: this.provider,
          status: "down",
          message: `health endpoint status=${res.status}`,
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - started,
          accountRef: this.accountRef,
        };
      }
      return {
        provider: this.provider,
        status: (payload.status as "healthy" | "degraded" | "down" | undefined) ?? "healthy",
        message: String(payload.message ?? "ok"),
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        accountRef: this.accountRef,
      };
    } catch (error) {
      return {
        provider: this.provider,
        status: "down",
        message: error instanceof Error ? error.message : "health check failed",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        accountRef: this.accountRef,
      };
    }
  }
}

const DEFAULT_MOCK: Record<BrokerProvider, BrokerConnector> = {
  futu: new MockFutuConnector(),
  ib: new MockIbConnector(),
  ccxt: new MockCcxtConnector(),
};

export function getBrokerConnector(provider: BrokerProvider): BrokerConnector {
  return DEFAULT_MOCK[provider];
}

export function createBrokerConnector(config: BrokerRuntimeConfig): BrokerConnector {
  if (config.mode === "mock") {
    if (config.provider === "futu") return new MockFutuConnector(config.accountRef);
    if (config.provider === "ccxt") return new MockCcxtConnector(config.accountRef);
    return new MockIbConnector(config.accountRef);
  }
  if (!config.baseUrl) throw new Error(`missing broker baseUrl for ${config.provider}(${config.mode})`);
  return new HttpBrokerConnector({
    ...config,
    baseUrl: config.baseUrl,
    paper: paperFromMode(config.mode, config.paper),
  });
}

export function paperFromBrokerMode(mode: "mock" | "sandbox" | "live", explicit?: boolean): boolean {
  return paperFromMode(mode, explicit);
}
