import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/sqlite/client";
import { recommendationOutcome, recommendationSnapshot, workflowRun } from "../../db/sqlite/schema";

export type RecommendationSide = "long" | "short" | "neutral";
export type RecommendationOutcomeValue = "pending" | "win" | "loss" | "flat" | "invalid";

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
  rationale?: string;
  evidence?: unknown[];
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
  returnPct?: number | null;
  benchmarkReturnPct?: number | null;
  excessReturnPct?: number | null;
  hit?: boolean | null;
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
      rationale: input.rationale ?? "",
      evidenceJson: (input.evidence ?? []) as never,
      sourceArtifactKind: input.sourceArtifactKind ?? null,
      sourceArtifactId: input.sourceArtifactId ?? null,
      createdBy: input.createdBy ?? "agent",
      agentInstanceId: input.agentInstanceId ?? null,
      asof: input.asof ?? new Date().toISOString(),
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
        returnPct: input.returnPct ?? null,
        benchmarkReturnPct: input.benchmarkReturnPct ?? null,
        excessReturnPct: input.excessReturnPct ?? null,
        hit: input.hit ?? null,
        outcome: input.outcome,
        evaluatedAt: input.evaluatedAt ?? null,
      })
      .onConflictDoUpdate({
        target: [recommendationOutcome.recommendationId, recommendationOutcome.horizonDays],
        set: {
          startPrice: input.startPrice ?? null,
          endPrice: input.endPrice ?? null,
          returnPct: input.returnPct ?? null,
          benchmarkReturnPct: input.benchmarkReturnPct ?? null,
          excessReturnPct: input.excessReturnPct ?? null,
          hit: input.hit ?? null,
          outcome: input.outcome,
          evaluatedAt: input.evaluatedAt ?? null,
          updatedAt: new Date().toISOString(),
        },
      });
    return { id, recommendationId: input.recommendationId };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

export const recommendationService = new RecommendationService();
