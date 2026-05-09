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

export interface BrokerConnector {
  readonly provider: BrokerProvider;
  submitOrder(input: BrokerSubmitOrderInput): Promise<BrokerOrderResult>;
}

class MockFutuConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "futu";

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
}

class MockIbConnector implements BrokerConnector {
  readonly provider: BrokerProvider = "ib";

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
}

const CONNECTORS: Record<BrokerProvider, BrokerConnector> = {
  futu: new MockFutuConnector(),
  ib: new MockIbConnector(),
};

export function getBrokerConnector(provider: BrokerProvider): BrokerConnector {
  return CONNECTORS[provider];
}
