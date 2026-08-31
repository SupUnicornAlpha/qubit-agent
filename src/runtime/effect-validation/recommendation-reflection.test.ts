import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearForecastBookCatalogForTests,
  getForecastBookEntry,
} from "../market/contracts/forecast-book-service";
import {
  clearResearchThesisCatalogForTests,
  writeResearchThesis,
} from "../market/contracts/research-thesis-service";
import { applyRecommendationOutcomeToForecastBook } from "./recommendation-reflection";

afterEach(() => {
  clearResearchThesisCatalogForTests();
  clearForecastBookCatalogForTests();
});

describe("recommendation outcome reflection", () => {
  test("only projects an explicitly thesis-bound primary outcome to the Forecast Book", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-recommendation-reflection-"));
    try {
      const thesis = await writeResearchThesis(
        {
          snapshotId: "mkt_snapshot_reflection",
          instrumentScope: ["US:AAPL"],
          direction: "long",
          horizon: "5d",
          confidence: 0.7,
          modelAndPromptVersion: "test/v1",
        },
        { dataDir }
      );
      const result = await applyRecommendationOutcomeToForecastBook(
        {
          recommendationId: "rec-reflection-1",
          sourceArtifactKind: "research_thesis",
          sourceArtifactId: thesis.thesisId,
          horizonDays: 5,
          outcome: "win",
          returnPct: 4.2,
          excessReturnPct: 1.1,
          maxAdverseExcursionPct: -1.8,
          stopLossTriggered: false,
          takeProfitTriggered: true,
          evaluatedAt: "2026-08-31T00:00:00.000Z",
          marketDataFingerprint: "outcome_market_abc",
        },
        { dataDir }
      );
      expect(result.status).toBe("applied");
      const entry = await getForecastBookEntry(thesis.thesisId, dataDir);
      expect(entry?.recommendationId).toBe("rec-reflection-1");
      expect(entry?.holdingPeriodResult).toMatchObject({
        horizon: "5d",
        realizedReturnPct: 4.2,
        hitTarget: true,
        status: "evaluated",
      });
      expect(entry?.reflection?.classification).toBe("confirmed");
      expect(entry?.attribution.notes).toContain("market_data_fingerprint=outcome_market_abc");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not infer a causal thesis link from a symbol or workflow", async () => {
    const result = await applyRecommendationOutcomeToForecastBook({
      recommendationId: "rec-unbound",
      sourceArtifactKind: null,
      sourceArtifactId: null,
      horizonDays: 5,
      outcome: "loss",
      returnPct: -2,
      excessReturnPct: -3,
      maxAdverseExcursionPct: -4,
      stopLossTriggered: false,
      takeProfitTriggered: false,
      evaluatedAt: "2026-08-31T00:00:00.000Z",
      marketDataFingerprint: null,
    });
    expect(result).toEqual({ status: "skipped", reason: "recommendation_thesis_binding_missing" });
  });
});
