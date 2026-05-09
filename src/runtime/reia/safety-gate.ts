import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { intentOrder } from "../../db/sqlite/schema";
import { loadRiskConfig } from "../config/risk-config";
import { loadExecutionSafetyConfig } from "../config/execution-safety-config";

type ConfirmState = {
  intentOrderId: string;
  expiresAt: number;
  riskScore: number;
};

const confirmTokens = new Map<string, ConfirmState>();

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
  const expiresAt = Date.now() + safetyCfg.confirmTokenTtlSec * 1000;
  confirmTokens.set(confirmToken, { intentOrderId, expiresAt, riskScore: finalRiskScore });

  return {
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
  const safetyCfg = await loadExecutionSafetyConfig();
  if (safetyCfg.requireDoubleConfirm) {
    if (!input.confirmToken) throw new Error("confirmToken is required");
    const state = confirmTokens.get(input.confirmToken);
    if (!state) throw new Error("invalid confirmToken");
    if (Date.now() > state.expiresAt) {
      confirmTokens.delete(input.confirmToken);
      throw new Error("confirmToken expired");
    }
    if (state.intentOrderId !== input.intentOrderId) {
      throw new Error("confirmToken does not match intentOrderId");
    }
  }
  const liveAllowed = !safetyCfg.dryRunOnly && !input.forceDryRun;
  return {
    executeMode: liveAllowed ? ("live" as const) : ("paper" as const),
    safety: safetyCfg,
  };
}
