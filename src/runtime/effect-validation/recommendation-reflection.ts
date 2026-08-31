import {
  getForecastBookEntry,
  linkForecastBookEntry,
} from "../market/contracts/forecast-book-service";

export type RecommendationReflectionInput = {
  recommendationId: string;
  sourceArtifactKind: string | null;
  sourceArtifactId: string | null;
  horizonDays: number;
  outcome: "win" | "loss" | "flat" | "invalid";
  returnPct: number | null;
  excessReturnPct: number | null;
  maxAdverseExcursionPct: number | null;
  stopLossTriggered: boolean;
  takeProfitTriggered: boolean;
  evaluatedAt: string;
  marketDataFingerprint: string | null;
};

export type RecommendationReflectionResult =
  | { status: "applied"; thesisId: string; forecastBookEntryId: string }
  | { status: "skipped"; reason: string };

function thesisIdFromSource(
  input: Pick<RecommendationReflectionInput, "sourceArtifactKind" | "sourceArtifactId">
): string | null {
  const kind = input.sourceArtifactKind?.trim().toLowerCase() ?? "";
  const id = input.sourceArtifactId?.trim() ?? "";
  // A recommendation is only allowed to affect a thesis reflection when the
  // causal link was made explicitly at creation time. Symbol/workflow matches
  // are useful guards elsewhere, but are not a substitute for this binding.
  if (!id || !["thesis", "research_thesis"].includes(kind)) return null;
  return id;
}

/**
 * Projects a mature recommendation outcome onto the explicitly-linked thesis
 * Forecast Book. This is deliberately a one-way, auditable projection: it
 * never edits the thesis, prompt, strategy, or component configuration.
 */
export async function applyRecommendationOutcomeToForecastBook(
  input: RecommendationReflectionInput,
  options?: { dataDir?: string }
): Promise<RecommendationReflectionResult> {
  const thesisId = thesisIdFromSource(input);
  if (!thesisId) return { status: "skipped", reason: "recommendation_thesis_binding_missing" };

  const existing = await getForecastBookEntry(thesisId, options?.dataDir);
  if (existing?.recommendationId && existing.recommendationId !== input.recommendationId) {
    // The current Forecast Book schema represents one decision signal per
    // thesis. Do not silently overwrite a previous causal binding.
    return { status: "skipped", reason: "forecast_book_recommendation_conflict" };
  }

  try {
    const notes = [
      `recommendation_outcome=${input.outcome}`,
      `recommendation_id=${input.recommendationId}`,
      `horizon_days=${input.horizonDays}`,
      ...(input.excessReturnPct != null ? [`excess_return_pct=${input.excessReturnPct}`] : []),
      ...(input.marketDataFingerprint
        ? [`market_data_fingerprint=${input.marketDataFingerprint}`]
        : []),
      "outcome projection is observational and does not establish causal attribution",
    ];
    const entry = await linkForecastBookEntry(
      thesisId,
      {
        recommendationId: input.recommendationId,
        holdingPeriodResult: {
          horizon: `${input.horizonDays}d`,
          ...(input.returnPct != null ? { realizedReturnPct: input.returnPct } : {}),
          ...(input.maxAdverseExcursionPct != null
            ? { maxDrawdownPct: input.maxAdverseExcursionPct }
            : {}),
          hitTarget: input.takeProfitTriggered,
          hitStop: input.stopLossTriggered,
          evaluatedAt: input.evaluatedAt,
          status:
            input.outcome === "invalid" || input.stopLossTriggered ? "invalidated" : "evaluated",
          notes,
        },
        attributionNotes: notes,
      },
      options
    );
    return { status: "applied", thesisId, forecastBookEntryId: entry.entryId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.startsWith("thesis_not_found:") ||
      message.startsWith("forecast_book_missing_snapshot:")
    ) {
      return { status: "skipped", reason: "linked_thesis_not_found" };
    }
    throw error;
  }
}
