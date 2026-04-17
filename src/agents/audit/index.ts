import type { AgentRole, A2AMessageType } from "../../types/entities";
import type { A2AMessageEnvelope } from "../../types/a2a";
import { BaseAgent } from "../base.agent";
import { getDb } from "../../db/sqlite/client";
import { auditLog } from "../../db/sqlite/schema";

/**
 * AuditAgent — log archival, audit reporting, and accountable decision chain.
 *
 * Responsibilities:
 * - Subscribe to ALL A2A messages (wildcard) and write AuditLog records
 * - Track decision chains: who decided what, when, and why
 * - Expose audit report generation (via TASK_ASSIGN)
 * - Never block other agents — all writes are fire-and-forget
 */
export class AuditAgent extends BaseAgent {
  readonly role: AgentRole = "audit";
  readonly subscriptions: A2AMessageType[] = [
    "TASK_ASSIGN",
    "TASK_RESULT",
    "RISK_BLOCK",
    "ORDER_INTENT",
    "MODEL_UPDATE",
    "MEMORY_WRITE",
    "ALERT",
  ];

  protected async onInit(): Promise<void> {}

  protected async onMessage(msg: A2AMessageEnvelope): Promise<void> {
    // Fire-and-forget — never await in message handler
    this._writeAuditLog(msg).catch((err) =>
      console.warn("[AuditAgent] Failed to write audit log:", err)
    );
  }

  protected async onShutdown(): Promise<void> {}

  private async _writeAuditLog(msg: A2AMessageEnvelope): Promise<void> {
    const db = await getDb();
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      traceId: msg.traceId,
      workflowRunId: msg.workflowId,
      actorType: "agent",
      actorId: msg.senderAgent,
      action: msg.messageType,
      resourceType: "a2a_message",
      resourceId: msg.messageId,
      detailJson: {
        receiverAgent: msg.receiverAgent,
        priority: msg.priority,
        payloadPreview: JSON.stringify(msg.payload).slice(0, 500),
      },
    });
  }
}

export const auditAgent = new AuditAgent();
