import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/sqlite/client";
import { a2aMessage, agentInstance } from "../db/sqlite/schema";
import type { A2AMessageEnvelope } from "../types/a2a";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

async function resolveInstanceId(agentRef: string): Promise<string | null> {
  if (!agentRef || agentRef === "system") return null;
  if (!isUuid(agentRef)) return null;
  const db = await getDb();
  const rows = await db
    .select({ id: agentInstance.id })
    .from(agentInstance)
    .where(eq(agentInstance.id, agentRef))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * Persist an A2A envelope to SQLite for session monitor / audit.
 * Skips when sender is not a registered agent_instance (e.g. legacy "system" string).
 */
export async function persistA2AMessage(message: A2AMessageEnvelope): Promise<void> {
  const senderId = await resolveInstanceId(message.senderAgent);
  if (!senderId) return;

  const receiverId = message.receiverAgent
    ? await resolveInstanceId(message.receiverAgent)
    : null;

  const db = await getDb();
  await db.insert(a2aMessage).values({
    id: message.messageId || randomUUID(),
    workflowRunId: message.workflowId,
    traceId: message.traceId,
    senderInstanceId: senderId,
    receiverInstanceId: receiverId,
    messageType: message.messageType,
    payloadJson: message.payload ?? {},
    priority: message.priority ?? 50,
    createdAt: message.createdAt,
  });
}
