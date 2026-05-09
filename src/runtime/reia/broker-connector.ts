import { randomUUID } from "node:crypto";

export type BrokerProvider = "futu" | "ib";
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
}

export interface BrokerConnector {
  readonly provider: BrokerProvider;
  readonly mode: "mock" | "sandbox" | "live";
  readonly accountRef: string;
  submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult>;
  healthCheck(): Promise<BrokerHealthResult>;
}

class MockFutuConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "futu";
  readonly mode = "mock" as const;
  readonly accountRef = "futu-mock";

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

class MockIbConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "ib";
  readonly mode = "mock" as const;
  readonly accountRef = "ib-mock";

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

  constructor(input: { provider: BrokerProvider; mode: "sandbox" | "live"; baseUrl: string; accountRef: string }) {
    this.provider = input.provider;
    this.mode = input.mode;
    this.baseUrl = input.baseUrl.replace(/\/$/, "");
    this.accountRef = input.accountRef;
  }

  async submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult> {
    const started = Date.now();
    const res = await fetch(`${this.baseUrl}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, provider: this.provider, accountRef: this.accountRef }),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`broker submit failed: ${res.status} ${JSON.stringify(payload)}`);
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

  async healthCheck(): Promise<BrokerHealthResult> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.baseUrl}/health?provider=${this.provider}&accountRef=${this.accountRef}`);
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

const CONNECTORS: Record<BrokerProvider, BrokerConnector> = {
  futu: new MockFutuConnector(),
  ib: new MockIbConnector(),
};

export function getBrokerConnector(provider: BrokerProvider): BrokerConnector {
  return CONNECTORS[provider];
}

export function createBrokerConnector(config: BrokerRuntimeConfig): BrokerConnector {
  if (config.mode === "mock") return getBrokerConnector(config.provider);
  if (!config.baseUrl) throw new Error(`missing broker baseUrl for ${config.provider}(${config.mode})`);
  return new HttpBrokerConnector({
    provider: config.provider,
    mode: config.mode,
    baseUrl: config.baseUrl,
    accountRef: config.accountRef,
  });
}
