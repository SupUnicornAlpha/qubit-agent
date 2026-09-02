import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  indicatorStrategyScript,
  orderIntent,
  strategyEvalRun,
  strategyRuntime,
  strategyRuntimeLog,
  workflowRun,
} from "../../db/sqlite/schema";
import { ensureStrategyVersionForScript } from "../strategy/strategy-version-resolver";

export interface ShadowEvaluation {
  id: string;
  strategyRuntimeId: string;
  strategyVersionId: string;
  observedSignalCount: number;
  buySignalCount: number;
  sellSignalCount: number;
  observedBarCount: number;
  orderIntentCount: number;
  safetyStatus: "clean" | "order_intent_detected";
  promotionEligible: false;
  /** Shadow observation is never a performance pass/fail result. */
  pass: null;
}

/**
 * Materialize signal-only runtime evidence without fabricating fills, PnL, or
 * a promotion result. It is deliberately independent from PaperEvaluation.
 */
export class ShadowEvaluationService {
  async evaluate(strategyRuntimeId: string, client?: DbClient): Promise<ShadowEvaluation> {
    const db = client ?? (await getDb());
    const runtime = (
      await db
        .select()
        .from(strategyRuntime)
        .where(eq(strategyRuntime.id, strategyRuntimeId))
        .limit(1)
    )[0];
    if (!runtime) throw new Error("strategy_runtime_not_found");
    if (runtime.executionMode !== "shadow") throw new Error("shadow_runtime_required");
    const script = (
      await db
        .select()
        .from(indicatorStrategyScript)
        .where(eq(indicatorStrategyScript.id, runtime.strategyScriptId))
        .limit(1)
    )[0];
    if (!script) throw new Error("strategy_script_not_found");
    const { strategyVersionId, workflowRunId } = await ensureStrategyVersionForScript(db, script);
    const projectId = (
      await db
        .select({ projectId: workflowRun.projectId })
        .from(workflowRun)
        .where(eq(workflowRun.id, workflowRunId))
        .limit(1)
    )[0]?.projectId;
    if (!projectId) throw new Error("workflow_project_not_found");

    const observations = await db
      .select({
        payloadJson: strategyRuntimeLog.payloadJson,
        createdAt: strategyRuntimeLog.createdAt,
      })
      .from(strategyRuntimeLog)
      .where(
        and(
          eq(strategyRuntimeLog.strategyRuntimeId, strategyRuntimeId),
          eq(strategyRuntimeLog.message, "shadow_signal_observed")
        )
      );
    const intents = await db
      .select({ id: orderIntent.id })
      .from(orderIntent)
      .where(eq(orderIntent.strategyRuntimeId, strategyRuntimeId));
    const normalized = observations.map((row) => normalizePayload(row.payloadJson));
    const barTimes = new Set(
      normalized.flatMap((payload) => {
        const value = payload.barTime;
        return typeof value === "string" && value.trim() ? [value] : [];
      })
    );
    const buySignalCount = normalized.filter((payload) => payload.side === "buy").length;
    const sellSignalCount = normalized.filter((payload) => payload.side === "sell").length;
    const orderIntentCount = intents.length;
    const safetyStatus = orderIntentCount === 0 ? "clean" : "order_intent_detected";
    const params = normalizePayload(runtime.paramsJson);
    const compositionId = readCompositionId(params);
    const metricsJson = {
      schemaVersion: 1,
      strategyRuntimeId,
      observedSignalCount: observations.length,
      buySignalCount,
      sellSignalCount,
      observedBarCount: barTimes.size,
      orderIntentCount,
      safetyStatus,
      promotionEligible: false,
      // Promoting from signal presence would be a category error: no fills or
      // counterfactual PnL were observed in shadow mode.
      observationOnly: true,
    };
    const rows = await db
      .select()
      .from(strategyEvalRun)
      .where(
        and(
          eq(strategyEvalRun.strategyVersionId, strategyVersionId),
          eq(strategyEvalRun.evalKind, "shadow")
        )
      );
    const existing = rows.find(
      (row) => normalizePayload(row.metricsJson).strategyRuntimeId === strategyRuntimeId
    );
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await db
        .update(strategyEvalRun)
        .set({ metricsJson, qualityScore: null, pass: null, notes: shadowNotes(safetyStatus) })
        .where(eq(strategyEvalRun.id, existing.id));
    } else {
      await db.insert(strategyEvalRun).values({
        id,
        workflowRunId,
        projectId,
        strategyVersionId,
        compositionId,
        scenarioKey: "shadow_observation",
        evalKind: "shadow",
        metricsJson,
        qualityScore: null,
        pass: null,
        notes: shadowNotes(safetyStatus),
        createdBy: "shadow_evaluation",
      });
    }
    return {
      id,
      strategyRuntimeId,
      strategyVersionId,
      observedSignalCount: observations.length,
      buySignalCount,
      sellSignalCount,
      observedBarCount: barTimes.size,
      orderIntentCount,
      safetyStatus,
      promotionEligible: false,
      pass: null,
    };
  }
}

function shadowNotes(safetyStatus: ShadowEvaluation["safetyStatus"]) {
  return safetyStatus === "clean"
    ? "shadow_observation_only_not_promotion_evidence"
    : "shadow_safety_violation_order_intent_detected";
}

function normalizePayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readCompositionId(params: Record<string, unknown>): string | null {
  const value = params.compositionId ?? params.strategyCompositionId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const shadowEvaluationService = new ShadowEvaluationService();
