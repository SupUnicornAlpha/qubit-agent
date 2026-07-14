import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { recommendationOutcome, recommendationSnapshot, workflowRun } from "../../db/sqlite/schema";
import { appendAuditLog } from "../audit/audit-chain-service";

export type RecommendationSide = "long" | "short" | "neutral";
export type RecommendationOutcomeValue = "pending" | "win" | "loss" | "flat" | "invalid";
export type RecommendationStatus = "draft" | "active" | "closed" | "expired" | "invalidated";

export interface RecordRecommendationInput {
  workflowRunId: string;
  projectId?: string;
  scenarioKey?: string;
  symbol: string;
  market?: string;
  side: RecommendationSide;
  horizonDays?: number;
  confidence?: number;
  score?: number | null;
  entryLow?: number | null;
  entryHigh?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  positionSizePct?: number | null;
  riskRewardRatio?: number | null;
  rationale?: string;
  evidence?: unknown[];
  invalidation?: unknown[];
  watchConditions?: unknown[];
  benchmarkSymbol?: string | null;
  status?: RecommendationStatus;
  expiresAt?: string | null;
  dataAsof?: string | null;
  sourceArtifactKind?: string | null;
  sourceArtifactId?: string | null;
  createdBy?: string;
  agentInstanceId?: string | null;
  asof?: string;
}

export interface RecordRecommendationOutcomeInput {
  recommendationId: string;
  horizonDays: number;
  startPrice?: number | null;
  endPrice?: number | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  exitReason?: string | null;
  returnPct?: number | null;
  benchmarkReturnPct?: number | null;
  excessReturnPct?: number | null;
  hit?: boolean | null;
  maxFavorableExcursionPct?: number | null;
  maxAdverseExcursionPct?: number | null;
  stopLossTriggered?: boolean | null;
  takeProfitTriggered?: boolean | null;
  ambiguousBar?: boolean;
  barsObserved?: number;
  evaluationError?: string | null;
  outcome: RecommendationOutcomeValue;
  evaluatedAt?: string | null;
}

export class RecommendationServiceError extends Error {
  constructor(
    public code: "workflow_not_found" | "validation_failed",
    message: string
  ) {
    super(message);
    this.name = "RecommendationServiceError";
  }
}

export class RecommendationService {
  async record(input: RecordRecommendationInput) {
    const symbol = input.symbol.trim().toUpperCase();
    if (!symbol) {
      throw new RecommendationServiceError("validation_failed", "symbol_required");
    }
    const db = await getDb();
    let projectId = input.projectId;
    let scenarioKey = input.scenarioKey;
    if (!projectId || !scenarioKey) {
      const rows = await db
        .select({
          projectId: workflowRun.projectId,
          researchScenarioId: workflowRun.researchScenarioId,
        })
        .from(workflowRun)
        .where(eq(workflowRun.id, input.workflowRunId))
        .limit(1);
      const wf = rows[0];
      if (!wf) {
        throw new RecommendationServiceError(
          "workflow_not_found",
          `workflow_not_found: ${input.workflowRunId}`
        );
      }
      projectId ??= wf.projectId;
      scenarioKey ??= wf.researchScenarioId ?? "";
    }

    const id = randomUUID();
    await db.insert(recommendationSnapshot).values({
      id,
      workflowRunId: input.workflowRunId,
      projectId,
      scenarioKey: scenarioKey || "unknown",
      symbol,
      market: input.market ?? "US",
      side: input.side,
      horizonDays: input.horizonDays ?? 20,
      confidence: clamp01(input.confidence ?? 0.5),
      score: input.score ?? null,
      entryLow: finiteOrNull(input.entryLow),
      entryHigh: finiteOrNull(input.entryHigh),
      stopLoss: finiteOrNull(input.stopLoss),
      takeProfit: finiteOrNull(input.takeProfit),
      positionSizePct: computeDeterministicPositionSizePct(input),
      riskRewardRatio: finiteOrNull(input.riskRewardRatio) ?? computeRiskRewardRatio(input),
      rationale: input.rationale ?? "",
      evidenceJson: (input.evidence ?? []) as never,
      invalidationJson: (input.invalidation ?? []) as never,
      watchConditionsJson: (input.watchConditions ?? []) as never,
      benchmarkSymbol: input.benchmarkSymbol?.trim().toUpperCase() || null,
      status: input.status ?? "active",
      expiresAt: input.expiresAt ?? null,
      dataAsof: input.dataAsof ?? input.asof ?? null,
      sourceArtifactKind: input.sourceArtifactKind ?? null,
      sourceArtifactId: input.sourceArtifactId ?? null,
      createdBy: input.createdBy ?? "agent",
      agentInstanceId: input.agentInstanceId ?? null,
      asof: input.asof ?? new Date().toISOString(),
    });
    await appendAuditLog(db, {
      traceId: `recommendation:${id}`,
      workflowRunId: input.workflowRunId,
      agentInstanceId: input.agentInstanceId ?? null,
      actorType: input.createdBy === "user" ? "user" : "agent",
      actorId: input.createdBy ?? input.agentInstanceId ?? "recommendation_service",
      action: "recommendation_recorded",
      resourceType: "recommendation_snapshot",
      resourceId: id,
      detailJson: {
        symbol,
        side: input.side,
        horizonDays: input.horizonDays ?? 20,
        confidence: clamp01(input.confidence ?? 0.5),
        dataAsof: input.dataAsof ?? input.asof ?? null,
      },
    });
    return { id, symbol };
  }

  async recordOutcome(input: RecordRecommendationOutcomeInput) {
    const db = await getDb();
    const id = randomUUID();
    await db
      .insert(recommendationOutcome)
      .values({
        id,
        recommendationId: input.recommendationId,
        horizonDays: input.horizonDays,
        startPrice: input.startPrice ?? null,
        endPrice: input.endPrice ?? null,
        entryPrice: input.entryPrice ?? null,
        exitPrice: input.exitPrice ?? null,
        exitReason: input.exitReason ?? null,
        returnPct: input.returnPct ?? null,
        benchmarkReturnPct: input.benchmarkReturnPct ?? null,
        excessReturnPct: input.excessReturnPct ?? null,
        hit: input.hit ?? null,
        maxFavorableExcursionPct: input.maxFavorableExcursionPct ?? null,
        maxAdverseExcursionPct: input.maxAdverseExcursionPct ?? null,
        stopLossTriggered: input.stopLossTriggered ?? null,
        takeProfitTriggered: input.takeProfitTriggered ?? null,
        ambiguousBar: input.ambiguousBar ?? false,
        barsObserved: Math.max(0, Math.floor(input.barsObserved ?? 0)),
        evaluationError: input.evaluationError ?? null,
        outcome: input.outcome,
        evaluatedAt: input.evaluatedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [recommendationOutcome.recommendationId, recommendationOutcome.horizonDays],
        set: {
          startPrice: input.startPrice ?? null,
          endPrice: input.endPrice ?? null,
          entryPrice: input.entryPrice ?? null,
          exitPrice: input.exitPrice ?? null,
          exitReason: input.exitReason ?? null,
          returnPct: input.returnPct ?? null,
          benchmarkReturnPct: input.benchmarkReturnPct ?? null,
          excessReturnPct: input.excessReturnPct ?? null,
          hit: input.hit ?? null,
          maxFavorableExcursionPct: input.maxFavorableExcursionPct ?? null,
          maxAdverseExcursionPct: input.maxAdverseExcursionPct ?? null,
          stopLossTriggered: input.stopLossTriggered ?? null,
          takeProfitTriggered: input.takeProfitTriggered ?? null,
          ambiguousBar: input.ambiguousBar ?? false,
          barsObserved: Math.max(0, Math.floor(input.barsObserved ?? 0)),
          evaluationError: input.evaluationError ?? null,
          outcome: input.outcome,
          evaluatedAt: input.evaluatedAt ?? null,
          updatedAt: new Date().toISOString(),
        },
      });
    const recommendations = await db
      .select({ workflowRunId: recommendationSnapshot.workflowRunId })
      .from(recommendationSnapshot)
      .where(eq(recommendationSnapshot.id, input.recommendationId))
      .limit(1);
    await appendAuditLog(db, {
      traceId: `recommendation:${input.recommendationId}`,
      workflowRunId: recommendations[0]?.workflowRunId ?? null,
      actorType: "system",
      actorId: "recommendation_outcome_evaluator",
      action: "recommendation_outcome_recorded",
      resourceType: "recommendation_outcome",
      resourceId: id,
      detailJson: {
        recommendationId: input.recommendationId,
        horizonDays: input.horizonDays,
        outcome: input.outcome,
        returnPct: input.returnPct ?? null,
        excessReturnPct: input.excessReturnPct ?? null,
      },
    });
    return { id, recommendationId: input.recommendationId };
  }

  async list(
    input: {
      projectId?: string;
      symbol?: string;
      side?: RecommendationSide;
      status?: RecommendationStatus;
      limit?: number;
    } = {}
  ) {
    const db = await getDb();
    const conditions = [
      input.projectId ? eq(recommendationSnapshot.projectId, input.projectId) : undefined,
      input.symbol
        ? eq(recommendationSnapshot.symbol, input.symbol.trim().toUpperCase())
        : undefined,
      input.side ? eq(recommendationSnapshot.side, input.side) : undefined,
      input.status ? eq(recommendationSnapshot.status, input.status) : undefined,
    ].filter((condition): condition is NonNullable<typeof condition> => Boolean(condition));
    const rows = await db
      .select()
      .from(recommendationSnapshot)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(recommendationSnapshot.asof))
      .limit(Math.max(1, Math.min(input.limit ?? 100, 500)));

    if (rows.length === 0) return [];
    const outcomes = await db
      .select()
      .from(recommendationOutcome)
      .where(
        inArray(
          recommendationOutcome.recommendationId,
          rows.map((row) => row.id)
        )
      );
    const outcomesByRecommendation = new Map<string, typeof outcomes>();
    for (const outcome of outcomes) {
      const bucket = outcomesByRecommendation.get(outcome.recommendationId) ?? [];
      bucket.push(outcome);
      outcomesByRecommendation.set(outcome.recommendationId, bucket);
    }
    return rows.map((row) => {
      const rowOutcomes = (outcomesByRecommendation.get(row.id) ?? []).sort(
        (left, right) => left.horizonDays - right.horizonDays
      );
      return {
        ...row,
        outcomes: rowOutcomes,
        outcome:
          rowOutcomes.find((outcome) => outcome.horizonDays === row.horizonDays) ??
          rowOutcomes[0] ??
          null,
      };
    });
  }

  async get(id: string) {
    const db = await getDb();
    const rows = await db
      .select()
      .from(recommendationSnapshot)
      .where(eq(recommendationSnapshot.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const outcomes = await db
      .select()
      .from(recommendationOutcome)
      .where(eq(recommendationOutcome.recommendationId, id));
    return { ...row, outcomes };
  }

  async setStatus(id: string, status: RecommendationStatus) {
    const db = await getDb();
    const rows = await db
      .select({ workflowRunId: recommendationSnapshot.workflowRunId })
      .from(recommendationSnapshot)
      .where(eq(recommendationSnapshot.id, id))
      .limit(1);
    await db
      .update(recommendationSnapshot)
      .set({ status })
      .where(eq(recommendationSnapshot.id, id));
    await appendAuditLog(db, {
      traceId: `recommendation:${id}`,
      workflowRunId: rows[0]?.workflowRunId ?? null,
      actorType: "system",
      actorId: "recommendation_service",
      action: "recommendation_status_changed",
      resourceType: "recommendation_snapshot",
      resourceId: id,
      detailJson: { status },
    });
    return { id, status };
  }

  async stats(projectId?: string) {
    const rows = await this.list({ ...(projectId ? { projectId } : {}), limit: 500 });
    const horizons = [
      ...new Set(rows.flatMap((row) => row.outcomes.map((item) => item.horizonDays))),
    ].sort((left, right) => left - right);
    const horizonStats = horizons.map((horizonDays) => buildHorizonStats(rows, horizonDays));
    const fallbackHorizon = rows[0]?.horizonDays ?? 20;
    const primaryStats =
      horizonStats.find((item) => item.horizonDays === 20) ??
      horizonStats.find((item) => item.horizonDays === fallbackHorizon) ??
      emptyHorizonStats(fallbackHorizon);
    return {
      total: rows.length,
      active: rows.filter((row) => row.status === "active").length,
      mature: primaryStats.mature,
      pending: primaryStats.pending,
      directional: primaryStats.directional,
      wins: primaryStats.wins,
      losses: primaryStats.losses,
      winRatePct: primaryStats.winRatePct,
      avgReturnPct: primaryStats.avgReturnPct,
      avgExcessReturnPct: primaryStats.avgExcessReturnPct,
      stopLossTriggerRatePct: primaryStats.stopLossTriggerRatePct,
      takeProfitTriggerRatePct: primaryStats.takeProfitTriggerRatePct,
      horizonStats,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

function computeRiskRewardRatio(input: RecordRecommendationInput): number | null {
  const entry = finiteOrNull(input.entryHigh) ?? finiteOrNull(input.entryLow);
  const stop = finiteOrNull(input.stopLoss);
  const target = finiteOrNull(input.takeProfit);
  if (entry == null || stop == null || target == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return risk > 0 ? reward / risk : null;
}

export function computeDeterministicPositionSizePct(
  input: Pick<
    RecordRecommendationInput,
    "entryLow" | "entryHigh" | "stopLoss" | "confidence" | "positionSizePct"
  >,
  riskBudgetPct = 0.01,
  maxPositionPct = 0.25
): number | null {
  const entry = finiteOrNull(input.entryHigh) ?? finiteOrNull(input.entryLow);
  const stop = finiteOrNull(input.stopLoss);
  if (entry == null || stop == null || entry <= 0 || entry === stop) {
    return input.positionSizePct == null
      ? null
      : Math.min(maxPositionPct, clamp01(input.positionSizePct));
  }
  const stopDistancePct = Math.abs(entry - stop) / entry;
  const confidenceScale = 0.5 + clamp01(input.confidence ?? 0.5) * 0.5;
  return Math.min(maxPositionPct, (riskBudgetPct / stopDistancePct) * confidenceScale);
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

type ListedRecommendation = Awaited<ReturnType<RecommendationService["list"]>>[number];
type ListedOutcome = ListedRecommendation["outcomes"][number];

function buildHorizonStats(rows: ListedRecommendation[], horizonDays: number) {
  const observations = rows.map((row) => ({
    row,
    outcome: row.outcomes.find((item) => item.horizonDays === horizonDays) ?? null,
  }));
  const mature = observations.filter(
    (item): item is { row: ListedRecommendation; outcome: ListedOutcome } =>
      Boolean(item.outcome && item.outcome.outcome !== "pending")
  );
  const directional = mature.filter(
    (item) => item.row.side !== "neutral" && item.outcome.outcome !== "invalid"
  );
  const wins = directional.filter((item) => item.outcome.outcome === "win").length;
  const numeric = (
    key: "returnPct" | "excessReturnPct" | "maxAdverseExcursionPct" | "maxFavorableExcursionPct"
  ) =>
    directional
      .map((item) => item.outcome[key])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const calibration = buildCalibration(directional);
  return {
    horizonDays,
    total: observations.length,
    mature: mature.length,
    pending: observations.filter((item) => !item.outcome || item.outcome.outcome === "pending")
      .length,
    directional: directional.length,
    wins,
    losses: directional.filter((item) => item.outcome.outcome === "loss").length,
    flat: directional.filter((item) => item.outcome.outcome === "flat").length,
    invalid: mature.filter((item) => item.outcome.outcome === "invalid").length,
    winRatePct: directional.length > 0 ? (wins / directional.length) * 100 : null,
    avgReturnPct: average(numeric("returnPct")),
    avgExcessReturnPct: average(numeric("excessReturnPct")),
    avgMaePct: average(numeric("maxAdverseExcursionPct")),
    avgMfePct: average(numeric("maxFavorableExcursionPct")),
    stopLossTriggerRatePct: triggerRate(directional, "stopLossTriggered"),
    takeProfitTriggerRatePct: triggerRate(directional, "takeProfitTriggered"),
    ...calibration,
  };
}

function emptyHorizonStats(horizonDays: number) {
  return buildHorizonStats([], horizonDays);
}

function buildCalibration(
  observations: Array<{ row: ListedRecommendation; outcome: ListedOutcome }>
) {
  const bins = Array.from({ length: 5 }, (_, index) => ({
    minConfidence: index / 5,
    maxConfidence: (index + 1) / 5,
    values: [] as Array<{ confidence: number; actual: number }>,
  }));
  for (const item of observations) {
    const confidence = clamp01(item.row.confidence);
    const actual = item.outcome.outcome === "win" ? 1 : 0;
    bins[Math.min(4, Math.floor(confidence * 5))]?.values.push({ confidence, actual });
  }
  const calibrationBins = bins.map((bin) => ({
    minConfidence: bin.minConfidence,
    maxConfidence: bin.maxConfidence,
    count: bin.values.length,
    avgConfidence: average(bin.values.map((item) => item.confidence)),
    accuracyPct:
      bin.values.length > 0
        ? (bin.values.reduce((sum, item) => sum + item.actual, 0) / bin.values.length) * 100
        : null,
  }));
  if (observations.length === 0) return { brierScore: null, ece: null, calibrationBins };
  const brierScore = average(
    observations.map((item) => {
      const error = clamp01(item.row.confidence) - (item.outcome.outcome === "win" ? 1 : 0);
      return error * error;
    })
  );
  const ece = calibrationBins.reduce((sum, bin) => {
    if (bin.count === 0 || bin.avgConfidence == null || bin.accuracyPct == null) return sum;
    return (
      sum + (bin.count / observations.length) * Math.abs(bin.avgConfidence - bin.accuracyPct / 100)
    );
  }, 0);
  return { brierScore, ece, calibrationBins };
}

function triggerRate(
  rows: Array<{ row: ListedRecommendation; outcome: ListedOutcome }>,
  key: "stopLossTriggered" | "takeProfitTriggered"
): number | null {
  const configured = rows.filter((item) =>
    key === "stopLossTriggered" ? item.row.stopLoss != null : item.row.takeProfit != null
  );
  if (configured.length === 0) return null;
  const triggered = configured.filter((item) => item.outcome[key] === true).length;
  return (triggered / configured.length) * 100;
}

export const recommendationService = new RecommendationService();
