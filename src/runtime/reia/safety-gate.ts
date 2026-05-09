import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { executionConfirmTicket, intentOrder } from "../../db/sqlite/schema";
import { loadRiskConfig } from "../config/risk-config";
import { loadExecutionSafetyConfig } from "../config/execution-safety-config";

function computeFinalRiskScore(input: {
  expectedRisk?: number | null;
  expectedReturn?: number | null;
}): number {
  const risk = Number(input.expectedRisk ?? 0.4);
  const ret = Number(input.expectedReturn ?? 0.15);
  // expectedRisk 高 + expectedReturn 低 => 风险更高
  const rrPenalty = ret <= 0 ? 0.3 : Math.max(0, 0.2 - ret);
  return Math.max(0, Math.min(1, risk * 0.8 + rrPenalty));
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function requestExecutionConfirmation(intentOrderId: string) {
  const db = await getDb();
  const rows = await db.select().from(intentOrder).where(eq(intentOrder.id, intentOrderId)).limit(1);
  const intent = rows[0];
  if (!intent) throw new Error("intent order not found");

  const [riskCfg, safetyCfg] = await Promise.all([loadRiskConfig(), loadExecutionSafetyConfig()]);
  const finalRiskScore = computeFinalRiskScore({
    expectedRisk: intent.expectedRisk,
    expectedReturn: intent.expectedReturn,
  });
  const riskAllowed =
    finalRiskScore < Math.min(riskCfg.vetoThreshold, safetyCfg.finalRiskScoreThreshold);

  const reasons: string[] = [];
  if (!riskAllowed) reasons.push("final_risk_check_failed");
  if (safetyCfg.dryRunOnly) reasons.push("dry_run_only_enabled");

  const confirmToken = randomUUID();
  const now = Date.now();
  const expiresAt = now + safetyCfg.confirmTokenTtlSec * 1000;
  const ticketId = randomUUID();
  await db.insert(executionConfirmTicket).values({
    id: ticketId,
    intentOrderId,
    confirmTokenHash: hashToken(confirmToken),
    issuedBy: "system",
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    status: "active",
    riskScoreSnapshot: finalRiskScore,
    blockersJson: reasons,
  });

  return {
    ticketId,
    intentOrderId,
    finalRiskScore,
    riskAllowed,
    dryRunOnly: safetyCfg.dryRunOnly,
    requireDoubleConfirm: safetyCfg.requireDoubleConfirm,
    confirmToken,
    expiresAt,
    blockers: reasons,
  };
}

export async function verifyConfirmationAndAllowExecute(input: {
  intentOrderId: string;
  confirmToken?: string;
  forceDryRun?: boolean;
}) {
  const db = await getDb();
  const safetyCfg = await loadExecutionSafetyConfig();
  if (safetyCfg.requireDoubleConfirm) {
    if (!input.confirmToken) throw new Error("confirmToken is required");
    const tokenHash = hashToken(input.confirmToken);
    const rows = await db
      .select()
      .from(executionConfirmTicket)
      .where(
        and(
          eq(executionConfirmTicket.intentOrderId, input.intentOrderId),
          eq(executionConfirmTicket.confirmTokenHash, tokenHash),
          eq(executionConfirmTicket.status, "active")
        )
      )
      .orderBy(desc(executionConfirmTicket.createdAt))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw new Error("invalid confirmToken");
    if (Date.now() > Date.parse(ticket.expiresAt)) {
      await db
        .update(executionConfirmTicket)
        .set({ status: "expired" })
        .where(eq(executionConfirmTicket.id, ticket.id));
      throw new Error("confirmToken expired");
    }
    await db
      .update(executionConfirmTicket)
      .set({ status: "consumed", consumedAt: new Date().toISOString() })
      .where(eq(executionConfirmTicket.id, ticket.id));
  }
  const liveAllowed = !safetyCfg.dryRunOnly && !input.forceDryRun;
  return {
    executeMode: liveAllowed ? ("live" as const) : ("paper" as const),
    safety: safetyCfg,
  };
}

export async function listExecutionConfirmTickets(intentOrderId: string) {
  const db = await getDb();
  return db
    .select({
      id: executionConfirmTicket.id,
      intentOrderId: executionConfirmTicket.intentOrderId,
      issuedBy: executionConfirmTicket.issuedBy,
      issuedAt: executionConfirmTicket.issuedAt,
      expiresAt: executionConfirmTicket.expiresAt,
      consumedAt: executionConfirmTicket.consumedAt,
      status: executionConfirmTicket.status,
      riskScoreSnapshot: executionConfirmTicket.riskScoreSnapshot,
      blockersJson: executionConfirmTicket.blockersJson,
      createdAt: executionConfirmTicket.createdAt,
    })
    .from(executionConfirmTicket)
    .where(eq(executionConfirmTicket.intentOrderId, intentOrderId))
    .orderBy(desc(executionConfirmTicket.createdAt));
}

export async function cleanupExpiredExecutionConfirmTickets() {
  const db = await getDb();
  const nowIso = new Date().toISOString();
  const rows = await db
    .select({ id: executionConfirmTicket.id })
    .from(executionConfirmTicket)
    .where(and(eq(executionConfirmTicket.status, "active"), lt(executionConfirmTicket.expiresAt, nowIso)));
  if (rows.length === 0) return { cleaned: 0 };
  for (const row of rows) {
    await db
      .update(executionConfirmTicket)
      .set({ status: "expired" })
      .where(eq(executionConfirmTicket.id, row.id));
  }
  return { cleaned: rows.length };
}
