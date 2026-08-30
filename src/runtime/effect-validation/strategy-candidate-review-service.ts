import { randomUUID } from "node:crypto";
import { and, desc, eq, ne } from "drizzle-orm";
import { type DbClient, getDb } from "../../db/sqlite/client";
import {
  strategy,
  strategyCandidateReview,
  strategyComposition,
  strategyVersion,
} from "../../db/sqlite/schema";

export type StrategyCandidateDecision = "eligible" | "incomplete" | "rejected" | "retired";

export type StrategyCandidateReviewInput = {
  projectId: string;
  strategyVersionId: string;
  /** Must be a real frozen cohort ID or an explicit review-only identifier. */
  comparisonCohortId: string;
  decision: StrategyCandidateDecision;
  reasonCodes: string[];
  duplicateOfStrategyVersionId?: string | null;
  regimeEvidence?: Array<Record<string, unknown>>;
  capacityEvidence?: Record<string, unknown>;
  correlationEvidence?: Record<string, unknown>;
  createdBy?: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableReasons(values: string[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))].sort();
}

function reviewCohortId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("strategy_candidate_review_cohort_required");
  if (
    !/^strategy_cohort_[a-f0-9]{24}$/.test(normalized) &&
    !/^review_[a-z0-9][a-z0-9._:-]{2,127}$/.test(normalized)
  ) {
    throw new Error("strategy_candidate_review_cohort_invalid");
  }
  return normalized;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function stringIds(value: unknown, sort = false): string[] {
  const values = Array.isArray(value) ? value.map(text).filter(Boolean) : [];
  return sort ? [...values].sort() : values;
}

/**
 * A deliberately conservative structural identity for composed strategies.
 * Factor score order does not affect the current scorer, while rule order is
 * retained because future rule engines may make it meaningful. Names,
 * provenance and parent lineage are intentionally excluded.
 */
function compositionFingerprint(row: typeof strategyComposition.$inferSelect): string {
  return canonicalJson({
    kind: row.kind,
    factorIds: stringIds(row.factorIdsJson, true),
    ruleIds: stringIds(row.ruleIdsJson),
    weightMethod: row.weightMethod,
    rebalanceFreq: row.rebalanceFreq,
    universe: row.universe,
    params: row.paramsJson,
  });
}

/**
 * Durable strategy graveyard. Upsert is deliberately keyed by strategy +
 * frozen comparison cohort: a later experiment on different frozen evidence
 * becomes a new review instead of silently overwriting historical failure.
 */
export class StrategyCandidateReviewService {
  /**
   * Finds only an exact structural predecessor in the same project. It never
   * infers similarity from returns, a shared symbol, or losing to a champion.
   */
  async findExactStructuralDuplicate(
    projectId: string,
    strategyVersionId: string,
    client?: DbClient
  ): Promise<string | null> {
    const db = client ?? (await getDb());
    const sourceCompositions = await db
      .select()
      .from(strategyComposition)
      .where(eq(strategyComposition.strategyVersionId, strategyVersionId));
    const candidates = await db
      .select({
        versionId: strategyVersion.id,
        logicHash: strategyVersion.logicHash,
        composition: strategyComposition,
      })
      .from(strategyVersion)
      .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
      .leftJoin(strategyComposition, eq(strategyComposition.strategyVersionId, strategyVersion.id))
      .where(and(eq(strategy.projectId, projectId), ne(strategyVersion.id, strategyVersionId)))
      .orderBy(strategyVersion.createdAt, strategyVersion.id);

    if (sourceCompositions.length) {
      const signatures = new Set(sourceCompositions.map(compositionFingerprint));
      return (
        candidates.find(
          (candidate) =>
            candidate.composition && signatures.has(compositionFingerprint(candidate.composition))
        )?.versionId ?? null
      );
    }

    const source = (
      await db
        .select({ logicHash: strategyVersion.logicHash })
        .from(strategyVersion)
        .where(eq(strategyVersion.id, strategyVersionId))
        .limit(1)
    )[0];
    if (!source?.logicHash) return null;
    return (
      candidates.find(
        (candidate) => !candidate.composition && candidate.logicHash === source.logicHash
      )?.versionId ?? null
    );
  }

  async record(input: StrategyCandidateReviewInput, client?: DbClient) {
    const db = client ?? (await getDb());
    const projectId = text(input.projectId);
    const strategyVersionId = text(input.strategyVersionId);
    if (!projectId || !strategyVersionId) {
      throw new Error("strategy_candidate_review_project_and_version_required");
    }
    const comparisonCohortId = reviewCohortId(input.comparisonCohortId);
    const version = (
      await db
        .select({ id: strategyVersion.id })
        .from(strategyVersion)
        .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
        .where(and(eq(strategyVersion.id, strategyVersionId), eq(strategy.projectId, projectId)))
        .limit(1)
    )[0];
    if (!version) throw new Error("strategy_candidate_review_strategy_version_not_found");
    const explicitDuplicateOf = text(input.duplicateOfStrategyVersionId) || null;
    const inferredDuplicateOf = explicitDuplicateOf
      ? null
      : await this.findExactStructuralDuplicate(projectId, strategyVersionId, db);
    const duplicateOfStrategyVersionId = explicitDuplicateOf ?? inferredDuplicateOf;
    const reasons = stableReasons([
      ...input.reasonCodes,
      ...(inferredDuplicateOf && input.decision !== "eligible" ? ["exact_structural_duplicate"] : []),
    ]);
    if (input.decision !== "eligible" && reasons.length === 0) {
      throw new Error("strategy_candidate_review_reason_required");
    }
    if (duplicateOfStrategyVersionId === strategyVersionId) {
      throw new Error("strategy_candidate_review_duplicate_self_reference");
    }
    if (duplicateOfStrategyVersionId) {
      const duplicate = (
        await db
          .select({ id: strategyVersion.id })
          .from(strategyVersion)
          .innerJoin(strategy, eq(strategyVersion.strategyId, strategy.id))
          .where(
            and(
              eq(strategyVersion.id, duplicateOfStrategyVersionId),
              eq(strategy.projectId, projectId)
            )
          )
          .limit(1)
      )[0];
      if (!duplicate) throw new Error("strategy_candidate_review_duplicate_version_not_found");
    }
    const existing = (
      await db
        .select({ id: strategyCandidateReview.id })
        .from(strategyCandidateReview)
        .where(
          and(
            eq(strategyCandidateReview.projectId, projectId),
            eq(strategyCandidateReview.strategyVersionId, strategyVersionId),
            eq(strategyCandidateReview.comparisonCohortId, comparisonCohortId)
          )
        )
        .limit(1)
    )[0];
    const now = new Date().toISOString();
    const values = {
      decision: input.decision,
      reasonCodesJson: reasons,
      duplicateOfStrategyVersionId,
      regimeEvidenceJson: input.regimeEvidence ?? [],
      capacityEvidenceJson: input.capacityEvidence ?? {},
      correlationEvidenceJson: input.correlationEvidence ?? {},
      createdBy: text(input.createdBy) || "system",
      updatedAt: now,
    };
    const id = existing?.id ?? randomUUID();
    if (existing) {
      await db.update(strategyCandidateReview).set(values).where(eq(strategyCandidateReview.id, id));
    } else {
      await db.insert(strategyCandidateReview).values({
        id,
        projectId,
        strategyVersionId,
        comparisonCohortId,
        ...values,
        createdAt: now,
      });
    }
    return this.get(id, db);
  }

  async get(id: string, client?: DbClient) {
    const db = client ?? (await getDb());
    const row = (
      await db.select().from(strategyCandidateReview).where(eq(strategyCandidateReview.id, id)).limit(1)
    )[0];
    return row ?? null;
  }

  async list(projectId: string, client?: DbClient) {
    const db = client ?? (await getDb());
    return db
      .select()
      .from(strategyCandidateReview)
      .where(eq(strategyCandidateReview.projectId, projectId.trim()))
      .orderBy(desc(strategyCandidateReview.updatedAt));
  }
}

export const strategyCandidateReviewService = new StrategyCandidateReviewService();
