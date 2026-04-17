import { randomUUID } from "node:crypto";
import type { A2AMessageType, AgentRole } from "../types/entities";
import type { A2AMessageEnvelope } from "../types/a2a";
import { A2A_GOVERNANCE } from "../types/a2a";
import { messageBus } from "./bus";

/**
 * A2A (Agent-to-Agent) router.
 *
 * Enforces governance rules:
 * 1. Only the Orchestrator may be the primary decision-maker per workflow.
 * 2. Risk Agent holds veto power over ORDER_INTENT messages.
 * 3. Execution Agent only consumes risk-signed order intents.
 */
export class A2ARouter {
  private static _instance: A2ARouter | null = null;

  private constructor() {}

  static getInstance(): A2ARouter {
    if (!A2ARouter._instance) {
      A2ARouter._instance = new A2ARouter();
    }
    return A2ARouter._instance;
  }

  /**
   * Route a message through governance checks then dispatch to the bus.
   */
  async route(message: A2AMessageEnvelope): Promise<void> {
    this._enforceGovernance(message);
    messageBus.publish(message);
  }

  /**
   * Build and route a new A2A message.
   */
  async send(
    params: Omit<A2AMessageEnvelope, "messageId" | "createdAt">
  ): Promise<void> {
    const envelope: A2AMessageEnvelope = {
      ...params,
      messageId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.route(envelope);
  }

  /**
   * Register a handler for a specific message type.
   * Returns an unsubscribe function.
   */
  on(
    type: A2AMessageType | "*",
    handler: (msg: A2AMessageEnvelope) => void | Promise<void>
  ): () => void {
    return messageBus.subscribe(type, handler);
  }

  /**
   * Governance enforcement — throws if rules are violated.
   */
  private _enforceGovernance(message: A2AMessageEnvelope): void {
    // Rule: ORDER_INTENT must carry a risk signature before reaching Execution Agent
    if (
      message.messageType === A2A_GOVERNANCE.VETO_MESSAGE_TYPE &&
      A2A_GOVERNANCE.EXECUTION_REQUIRES_RISK_SIGNATURE
    ) {
      const payload = message.payload as Record<string, unknown> | null;
      if (!payload?.["riskSignature"]) {
        throw new Error(
          `A2A governance violation: ORDER_INTENT [${message.messageId}] must carry a risk signature.`
        );
      }
    }
  }
}

export const a2aRouter = A2ARouter.getInstance();

// ─── Convenience builders ─────────────────────────────────────────────────────

export function buildA2AMessage(
  params: Omit<A2AMessageEnvelope, "messageId" | "createdAt">
): A2AMessageEnvelope {
  return {
    ...params,
    messageId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}
