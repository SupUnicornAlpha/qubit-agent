import { createHmac } from "node:crypto";
import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope, OrderIntentPayload, RiskBlockPayload } from "../../types/a2a";
import { BaseAgent } from "../base.agent";

/**
 * RiskAgent — portfolio/order/channel risk arbitration with veto power.
 *
 * Governance:
 * - Holds veto power over all ORDER_INTENT messages
 * - Signs allowed intents with HMAC; Execution Agent validates signature
 * - Supports pre-trade hard rules + intra-trade dynamic rules
 * - Supports human review path (risk_decision = "review")
 *
 * Responsibilities:
 * - Evaluate incoming ORDER_INTENT against active RiskRules
 * - Emit RISK_BLOCK (deny) or re-emit signed ORDER_INTENT (allow)
 * - Write RiskDecision records to SQLite
 */
export class RiskAgent extends BaseAgent {
  readonly role: AgentRole = "risk";
  readonly subscriptions: A2AMessageType[] = ["TASK_ASSIGN", "ORDER_INTENT"];

  private signingKey = process.env["QUBIT_RISK_SIGNING_KEY"] ?? "dev-secret";

  protected async onInit(): Promise<void> {
    // TODO: load active RiskRules from DB
  }

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    if (msg.messageType !== "ORDER_INTENT") return;

    const intent = msg.payload as OrderIntentPayload;
    const decision = await this._evaluate(intent);

    if (decision === "block") {
      const blockPayload: RiskBlockPayload = {
        orderIntentId: intent.orderIntentId,
        riskRuleId: "default",
        reason: "Risk check failed",
        severity: "block",
        signature: "",
      };
      await this.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: msg.senderAgent,
        messageType: "RISK_BLOCK",
        payload: blockPayload,
        priority: 90,
      });
    } else if (decision === "allow") {
      const signature = this._sign(intent.orderIntentId);
      await this.send({
        workflowId: msg.workflowId,
        traceId: msg.traceId,
        receiverAgent: "execution",
        messageType: "ORDER_INTENT",
        payload: { ...intent, riskSignature: signature },
        priority: msg.priority,
      });
    }
    // "review" — emit ALERT and await human confirmation (TODO)
  }

  protected async onShutdown(): Promise<void> {}

  private async _evaluate(
    _intent: OrderIntentPayload
  ): Promise<"allow" | "block" | "review"> {
    // TODO: evaluate against loaded RiskRules
    return "allow";
  }

  private _sign(orderIntentId: string): string {
    return createHmac("sha256", this.signingKey)
      .update(orderIntentId)
      .digest("hex");
  }
}

export const riskAgent = new RiskAgent();
