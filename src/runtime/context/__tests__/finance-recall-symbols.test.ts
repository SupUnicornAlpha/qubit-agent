import { describe, expect, test } from "bun:test";
import { experienceMatchesSymbols } from "../../context/finance-recall";
import type { Experience } from "../../../types/entities";

describe("experienceMatchesSymbols", () => {
  const base: Experience = {
    id: "e1",
    kind: "semantic",
    subKind: "research_conclusion",
    scope: "project",
    scopeId: "p1",
    definitionId: null,
    visibility: "project_shared",
    contentJson: { summary: "s" },
    tagsJson: ["symbol:AAPL"],
    qualityScore: 0.5,
    useCount: 0,
    successCount: 0,
    failCount: 0,
    decayAt: null,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    parentId: null,
    sourceRunId: null,
    embeddingRef: null,
    pinned: false,
    metadataJson: { symbols: ["MSFT"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("matches tag or metadata symbols", () => {
    expect(experienceMatchesSymbols(base, ["AAPL"])).toBe(true);
    expect(experienceMatchesSymbols(base, ["MSFT"])).toBe(true);
    expect(experienceMatchesSymbols(base, ["NVDA"])).toBe(false);
  });
});
