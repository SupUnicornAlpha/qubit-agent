import type { ConnectorMeta, ConnectorOrder, ConnectorFill, ConnectorOrderIntent, ConnectorPosition } from "../../types/connector";
import { BaseConnector } from "../base.connector";

/**
 * ExecutionConnector — abstract base for broker/gateway order execution adapters.
 * Concrete implementations: IBConnector, CTPConnector, FutuConnector, QMTConnector, etc.
 *
 * Security constraint: only consumes order intents that carry a valid risk signature.
 */
export abstract class ExecutionConnector extends BaseConnector {
  abstract readonly meta: ConnectorMeta;

  abstract submitOrder(intent: ConnectorOrderIntent): Promise<ConnectorOrder>;
  abstract cancelOrder(brokerOrderId: string): Promise<void>;
  abstract modifyOrder(brokerOrderId: string, params: ModifyOrderParams): Promise<ConnectorOrder>;
  abstract getOrder(brokerOrderId: string): Promise<ConnectorOrder>;
  abstract getPositions(accountId: string): Promise<ConnectorPosition[]>;
  abstract getFills(brokerOrderId: string): Promise<ConnectorFill[]>;

  protected async onExecute<TOutput>(operation: string, payload: unknown): Promise<TOutput> {
    switch (operation) {
      case "submit_order":
        return this.submitOrder(payload as ConnectorOrderIntent) as unknown as TOutput;
      case "cancel_order":
        await this.cancelOrder((payload as { brokerOrderId: string }).brokerOrderId);
        return undefined as TOutput;
      case "modify_order": {
        const p = payload as { brokerOrderId: string; params: ModifyOrderParams };
        return this.modifyOrder(p.brokerOrderId, p.params) as unknown as TOutput;
      }
      case "get_order":
        return this.getOrder((payload as { brokerOrderId: string }).brokerOrderId) as unknown as TOutput;
      case "get_positions":
        return this.getPositions((payload as { accountId: string }).accountId) as unknown as TOutput;
      case "get_fills":
        return this.getFills((payload as { brokerOrderId: string }).brokerOrderId) as unknown as TOutput;
      default:
        throw new Error(`ExecutionConnector: unknown operation "${operation}"`);
    }
  }

  protected validateRiskSignature(intent: ConnectorOrderIntent): void {
    if (!intent.riskSignature) {
      throw new Error(
        `ExecutionConnector: ORDER_INTENT [${intent.id}] rejected — missing risk signature.`
      );
    }
  }
}

// ─── Parameter / result types ─────────────────────────────────────────────────

export interface ModifyOrderParams {
  newQty?: number;
  newPrice?: number;
}
