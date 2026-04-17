import { createHmac } from "node:crypto";
import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope, OrderIntentPayload } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * ExecutionAgent — order routing, cancel/modify, fill state machine.
 *
 * Security:
 * - ONLY accepts ORDER_INTENT messages that carry a valid risk signature.
 * - Verifies HMAC signature before submitting to broker.
 *
 * Responsibilities:
 * - Validate risk signature on incoming ORDER_INTENT
 * - Route to ExecutionConnector via ACP (IB / CTP / Futu / QMT)
 * - Manage BrokerOrder state machine (submitted → filled / cancelled)
 * - Write BrokerOrder and Fill records to SQLite
 * - Emit ALERT on fill exceptions or rejections
 */
export class ExecutionAgent extends BaseAgent {
  readonly role: AgentRole = "execution";
  readonly subscriptions: A2AMessageType[] = ["ORDER_INTENT", "TASK_ASSIGN"];

  private signingKey = process.env["QUBIT_RISK_SIGNING_KEY"] ?? "dev-secret";

  protected async onInit(): Promise<void> {
    // TODO: connect to ExecutionConnector, subscribe to fill callbacks
  }

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    if (msg.messageType !== "ORDER_INTENT") return;

    const intent = msg.payload as OrderIntentPayload;

    if (!this._verifySignature(intent)) {
      console.error(
        `[ExecutionAgent] Rejected ORDER_INTENT [${intent.orderIntentId}]: invalid risk signature.`
      );
      return;
    }

    // TODO: submit order via ExecutionConnector, persist BrokerOrder
  }

  protected async onShutdown(): Promise<void> {
    // TODO: cancel all open orders on clean shutdown
  }

  private _verifySignature(intent: OrderIntentPayload): boolean {
    if (!intent.riskSignature) return false;
    const expected = createHmac("sha256", this.signingKey)
      .update(intent.orderIntentId)
      .digest("hex");
    return expected === intent.riskSignature;
  }
}

export const executionAgent = new ExecutionAgent();
