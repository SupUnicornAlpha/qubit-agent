import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearForecastBookCatalogForTests,
  ensureForecastBookForThesis,
  getForecastBookEntry,
  linkForecastBookEntry,
} from "./forecast-book-service";
import {
  clearResearchThesisCatalogForTests,
  getResearchThesisById,
  writeResearchThesis,
} from "./research-thesis-service";

function qualityGrowthCard() {
  return {
    version: "investment-framework-card-v1" as const,
    framework: "quality_growth" as const,
    sourceRefs: ["source:quality-growth-principles"],
    principles: [
      { statement: "Durable returns and reinvestment support compounding.", sourceRefs: ["source:quality-growth-principles"] },
    ],
    economicMechanism: "High-return businesses can reinvest cash flow at attractive rates.",
    observableProxies: [
      {
        key: "roic",
        label: "ROIC",
        comparison: "gte" as const,
        threshold: 0.15,
        weight: 1,
        sourceRefs: ["source:quality-growth-principles"],
      },
    ],
    selectionThreshold: 1,
    applicability: {
      assetClasses: ["equity"],
      markets: ["US"],
      regimes: ["normal"],
      holdingPeriod: "12m",
    },
    exclusionConditions: ["Accounting quality cannot be verified."],
    invalidation: [{ condition: "ROIC deteriorates", observable: "fund_roic" }],
    riskBudget: { maxPositionWeightPct: 0.1, maxPortfolioDrawdownPct: 0.15 },
  };
}

afterEach(() => {
  clearResearchThesisCatalogForTests();
  clearForecastBookCatalogForTests();
});

describe("research thesis + forecast book (D4)", () => {
  test("writes content-addressable thesis and reuses identical payload", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-thesis-"));
    try {
      const input = {
        snapshotId: "mkt_snapshot_01fixture",
        instrumentScope: ["SSE:600519"],
        direction: "long" as const,
        framework: "quality_growth" as const,
        frameworkCard: qualityGrowthCard(),
        horizon: "5d",
        confidence: 0.62,
        claims: [
          {
            claim: "近端量价结构支持温和上行",
            evidenceRefs: ["obs_1"],
            counterEvidenceRefs: [],
          },
        ],
        invalidation: [{ condition: "跌破近5日低点", observable: "bar.1d.low" }],
        knownUnknowns: ["公告不确定性"],
        modelAndPromptVersion: "fixture/v0",
        workflowRunId: "wf-1",
        role: "analyst_fundamental",
      };
      const a = await writeResearchThesis(input, { dataDir });
      const b = await writeResearchThesis(input, { dataDir });
      expect(a.thesisId).toBe(b.thesisId);
      expect(a.reused).toBe(false);
      expect(b.reused).toBe(true);
      expect(a.effects[0]?.kind).toBe("research_thesis");

      const loaded = await getResearchThesisById(a.thesisId, dataDir);
      expect(loaded?.thesis.direction).toBe("long");
      expect(loaded?.thesis.framework).toBe("quality_growth");
      expect(loaded?.thesis.frameworkCard?.observableProxies[0]?.key).toBe("roic");
      expect(loaded?.meta.workflowRunId).toBe("wf-1");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("forecast book opens with thesis and links idempotently", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-fb-"));
    try {
      const written = await writeResearchThesis(
        {
          snapshotId: "mkt_snapshot_abc",
          instrumentScope: ["US:AAPL"],
          direction: "short",
          horizon: "10d",
          confidence: 0.4,
          modelAndPromptVersion: "test/v1",
        },
        { dataDir }
      );

      const opened = await ensureForecastBookForThesis(
        { thesisId: written.thesisId, snapshotId: written.snapshotId },
        { dataDir }
      );
      expect(opened.entryId.startsWith("fb_")).toBe(true);
      expect(opened.holdingPeriodResult?.status).toBe("open");

      const linked = await linkForecastBookEntry(
        written.thesisId,
        {
          recommendationId: "rec-1",
          orderIntentIds: ["oi-1"],
          fillIds: ["fill-1", "fill-1"],
          holdingPeriodResult: {
            horizon: "10d",
            status: "evaluated",
            realizedReturnPct: 3.2,
            evaluatedAt: "2026-08-14T00:00:00.000Z",
          },
          attributionNotes: ["paper fill linked"],
        },
        { dataDir }
      );
      expect(linked.recommendationId).toBe("rec-1");
      expect(linked.fillIds).toEqual(["fill-1"]);
      expect(linked.holdingPeriodResult?.realizedReturnPct).toBe(3.2);
      expect(linked.reflection).toMatchObject({
        classification: "inconclusive",
        limitations: expect.arrayContaining(["outcome classification is not causal attribution"]),
      });

      const again = await linkForecastBookEntry(
        written.thesisId,
        { fillIds: ["fill-2"], orderIntentIds: ["oi-1"] },
        { dataDir }
      );
      expect(again.fillIds.sort()).toEqual(["fill-1", "fill-2"]);
      expect(again.orderIntentIds).toEqual(["oi-1"]);

      const byThesis = await getForecastBookEntry(written.thesisId, dataDir);
      expect(byThesis?.entryId).toBe(opened.entryId);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("requires evidence and a falsifier when a named investment framework is declared", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-thesis-framework-"));
    try {
      await expect(
        writeResearchThesis(
          {
            snapshotId: "mkt_snapshot_framework",
            instrumentScope: ["NASDAQ:AAPL"],
            direction: "long",
            framework: "quality_growth",
            horizon: "20d",
            confidence: 0.6,
            claims: [{ claim: "high quality" }],
            modelAndPromptVersion: "fixture/v1",
          },
          { dataDir }
        )
      ).rejects.toThrow(/framework_card_required/);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
