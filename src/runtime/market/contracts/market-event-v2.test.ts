import { describe, expect, test } from "bun:test";
import verdictFixture from "./fixtures/data-quality-verdict.fixture.json";
import quoteFixture from "./fixtures/market-event-quote.fixture.json";
import snapshotFixture from "./fixtures/market-snapshot.fixture.json";
import thesisFixture from "./fixtures/research-thesis.fixture.json";
import {
  DataQualityVerdictSchema,
  MarketEventSchema,
  MarketSnapshotSchema,
  ResearchThesisSchema,
  evaluateTradability,
} from "./market-event-v2";

describe("Market Event Contract v2 (D0)", () => {
  test("fixtures parse against frozen schemas", () => {
    expect(MarketEventSchema.parse(quoteFixture).schemaVersion).toBe(2);
    expect(DataQualityVerdictSchema.parse(verdictFixture).tradable).toBe(false);
    expect(MarketSnapshotSchema.parse(snapshotFixture).snapshotId).toBe("mkt_snapshot_01fixture");
    expect(ResearchThesisSchema.parse(thesisFixture).direction).toBe("long");
  });

  test("evaluateTradability is fail-closed for trading", () => {
    const base = {
      instrument: { symbol: "600519", venue: "SSE", assetClass: "equity" as const },
      feed: "licensed_realtime",
      kind: "quote" as const,
      asOf: "2026-08-04T01:30:00Z",
      freshness: "fresh" as const,
      completeness: "complete" as const,
      consistency: "verified" as const,
      structure: "valid" as const,
      pointInTime: "point_in_time_valid" as const,
      licenseUse: "trading_allowed" as const,
    };

    expect(evaluateTradability(base).tradable).toBe(true);
    expect(evaluateTradability({ ...base, licenseUse: "research_only" }).useClass).toBe(
      "research_only"
    );
    expect(evaluateTradability({ ...base, freshness: "stale" }).tradable).toBe(false);
    expect(evaluateTradability({ ...base, consistency: "divergent" }).tradable).toBe(false);
  });

  test("rejects eventTs masquerading without required fields", () => {
    expect(() =>
      MarketEventSchema.parse({
        ...quoteFixture,
        eventTs: undefined,
      })
    ).toThrow();
  });
});
