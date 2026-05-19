import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { intentOrder } from "../../db/sqlite/schema";
import type {
  ConnectorFill,
  ConnectorMeta,
  ConnectorOrder,
  ConnectorOrderIntent,
  ConnectorPosition,
  HealthCheckResult,
} from "../../types/connector";
import { executeIntentLive, executeIntentPaper } from "../../runtime/reia/intent-engine";
import {
  brokerCancelOrder,
  brokerGetFills,
  brokerGetPositions,
  brokerHealthCheck,
  resolveBrokerAccount,
} from "../../runtime/reia/broker-service";
import type { BrokerProvider } from "../../runtime/reia/broker-types";
import { ExecutionConnector, type ModifyOrderParams } from "./execution.connector";

function asProvider(v: unknown): BrokerProvider {
  if (v === "ib") return "ib";
  if (v === "ccxt") return "ccxt";
  return "futu";
}

export class QubitBrokerConnector extends ExecutionConnector {
  readonly meta: ConnectorMeta = {
    name: "qubit-broker",
    version: "0.1.0",
    connectorType: "execution",
    capabilities: ["submit_order", "cancel_order", "get_fills", "get_positions", "health_check"],
    assetClasses: ["stock", "crypto"],
    latencyProfile: "low",
    description: "QUBIT broker execution via configured broker_account (Futu/IB/CCXT).",
  };

  protected async onInit(): Promise<void> {
    /* no-op */
  }

  protected async onHealthcheck(): Promise<HealthCheckResult> {
    const provider = asProvider(process.env.QUBIT_BROKER_PROVIDER);
    const account = await resolveBrokerAccount(provider);
    if (!account) {
      return { status: "degraded", latencyMs: 0, message: "no broker account configured", checkedAt: "" };
    }
    const h = await brokerHealthCheck({ provider: account.provider, accountRef: account.accountRef });
    return {
      status: h.status === "healthy" ? "healthy" : h.status === "degraded" ? "degraded" : "unhealthy",
      latencyMs: h.latencyMs ?? 0,
      message: h.message,
      checkedAt: h.checkedAt,
    };
  }

  protected async onShutdown(): Promise<void> {
    /* no-op */
  }

  async submitOrder(intent: ConnectorOrderIntent): Promise<ConnectorOrder> {
    const intentOrderId =
      (intent.metadata?.intentOrderId as string | undefined) ??
      (intent.id.startsWith("intent-") ? intent.id : undefined);
    if (!intentOrderId) {
      throw new Error("submit_order: intentOrderId is required (pass in metadata.intentOrderId)");
    }

    const db = await getDb();
    const rows = await db.select().from(intentOrder).where(eq(intentOrder.id, intentOrderId)).limit(1);
    const order = rows[0];
    if (!order) throw new Error(`intent order not found: ${intentOrderId}`);
    if (order.status !== "approved") {
      throw new Error(`intent order ${intentOrderId} is not approved (status=${order.status})`);
    }

    const provider = asProvider(intent.metadata?.provider);
    const accountRef = intent.metadata?.accountRef as string | undefined;
    const paper = intent.metadata?.paper === true || intent.metadata?.executionMode === "paper";

    const result = paper
      ? await executeIntentPaper({ intentOrderId })
      : await executeIntentLive({ intentOrderId, provider, accountRef });

    const brokerOrderId =
      "brokerOrderId" in result && result.brokerOrderId
        ? String(result.brokerOrderId)
        : `intent-${intentOrderId}`;

    return {
      brokerOrderId,
      orderIntentId: intentOrderId,
      status: "filled",
      submittedAt: new Date().toISOString(),
    };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const provider = asProvider(process.env.QUBIT_BROKER_PROVIDER);
    await brokerCancelOrder({ provider, brokerOrderId });
  }

  async modifyOrder(_brokerOrderId: string, _params: ModifyOrderParams): Promise<ConnectorOrder> {
    throw new Error("modify_order is not supported for qubit-broker");
  }

  async getOrder(brokerOrderId: string): Promise<ConnectorOrder> {
    return {
      brokerOrderId,
      orderIntentId: "",
      status: "submitted",
      submittedAt: new Date().toISOString(),
    };
  }

  async getPositions(accountId: string): Promise<ConnectorPosition[]> {
    const provider = asProvider(process.env.QUBIT_BROKER_PROVIDER);
    const positions = await brokerGetPositions({ provider, accountRef: accountId || undefined });
    return positions.map((p) => ({
      accountId: accountId || "default",
      symbol: p.symbol,
      exchange: p.market ?? "",
      qty: p.qty,
      avgPrice: p.avgPrice,
      mtmPnl: 0,
      snapshotTime: new Date().toISOString(),
    }));
  }

  async getFills(brokerOrderId: string): Promise<ConnectorFill[]> {
    const provider = asProvider(process.env.QUBIT_BROKER_PROVIDER);
    const fills = await brokerGetFills({ provider, brokerOrderId });
    return fills.map((f) => ({
      brokerOrderId: f.brokerOrderId,
      fillQty: f.fillQty,
      fillPrice: f.fillPrice,
      fee: 0,
      filledAt: f.filledAt,
    }));
  }
}
