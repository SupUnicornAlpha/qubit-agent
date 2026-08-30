import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutionEvidenceBinding } from "./evidence-binding";
import { clearForecastBookCatalogForTests, getForecastBookEntry } from "./forecast-book-service";
import {
  buildMarketSnapshotRecord,
  clearMarketSnapshotCatalogForTests,
} from "./market-snapshot-service";
import { constructTargetPortfolio } from "./portfolio-construct-service";
import { clearResearchThesisCatalogForTests, writeResearchThesis } from "./research-thesis-service";

const prevThesis = process.env.QUBIT_ORDER_REQUIRE_THESIS;
const prevGate = process.env.QUBIT_MARKET_QUALITY_GATE;

afterEach(() => {
  clearResearchThesisCatalogForTests();
  clearForecastBookCatalogForTests();
  clearMarketSnapshotCatalogForTests();
  if (prevThesis === undefined) delete process.env.QUBIT_ORDER_REQUIRE_THESIS;
  else process.env.QUBIT_ORDER_REQUIRE_THESIS = prevThesis;
  if (prevGate === undefined) delete process.env.QUBIT_MARKET_QUALITY_GATE;
  else process.env.QUBIT_MARKET_QUALITY_GATE = prevGate;
});

describe("evidence binding (D5)", () => {
  test("live without thesis fails closed", async () => {
    process.env.QUBIT_ORDER_REQUIRE_THESIS = "1";
    process.env.QUBIT_MARKET_QUALITY_GATE = "1";
    const result = await resolveExecutionEvidenceBinding({ dispatchMode: "live" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("thesis_required");
  });

  test("paper without thesis is allowed with warning", async () => {
    process.env.QUBIT_ORDER_REQUIRE_THESIS = "1";
    const result = await resolveExecutionEvidenceBinding({ dispatchMode: "paper" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContain("evidence_binding:thesis_omitted_paper_compat");
    }
  });

  test("derives snapshot from thesis and rejects mismatch", async () => {
    process.env.QUBIT_ORDER_REQUIRE_THESIS = "1";
    process.env.QUBIT_MARKET_QUALITY_GATE = "0";
    const dataDir = await mkdtemp(join(tmpdir(), "qb-bind-"));
    try {
      const written = await writeResearchThesis(
        {
          snapshotId: "mkt_snapshot_bound",
          instrumentScope: ["US:AAPL"],
          direction: "long",
          horizon: "5d",
          confidence: 0.5,
          claims: [{ claim: "fixture claim", evidenceRefs: ["obs_fixture"] }],
          invalidation: [{ condition: "fixture breaks", observable: "bar.close" }],
          modelAndPromptVersion: "t/v1",
        },
        { dataDir }
      );

      const derived = await resolveExecutionEvidenceBinding(
        { dispatchMode: "live", thesisId: written.thesisId },
        { dataDir }
      );
      expect(derived.ok).toBe(true);
      if (derived.ok) {
        expect(derived.snapshotId).toBe("mkt_snapshot_bound");
        expect(derived.warnings).toContain("evidence_binding:snapshot_derived_from_thesis");
      }

      const mismatch = await resolveExecutionEvidenceBinding(
        {
          dispatchMode: "live",
          thesisId: written.thesisId,
          snapshotId: "mkt_snapshot_other",
        },
        { dataDir }
      );
      expect(mismatch.ok).toBe(false);
      if (!mismatch.ok) expect(mismatch.code).toBe("snapshot_thesis_mismatch");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("live rejects a thesis that has no evidence-backed falsifiable research", async () => {
    process.env.QUBIT_ORDER_REQUIRE_THESIS = "1";
    process.env.QUBIT_MARKET_QUALITY_GATE = "0";
    const dataDir = await mkdtemp(join(tmpdir(), "qb-bind-empty-"));
    try {
      const written = await writeResearchThesis(
        {
          snapshotId: "mkt_snapshot_empty",
          instrumentScope: ["US:AAPL"],
          direction: "long",
          horizon: "5d",
          confidence: 0.5,
          modelAndPromptVersion: "t/v1",
        },
        { dataDir }
      );
      const result = await resolveExecutionEvidenceBinding(
        { dispatchMode: "live", thesisId: written.thesisId },
        { dataDir }
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("thesis_not_auditable");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("portfolio.construct (D5)", () => {
  test("builds target portfolio bound to thesis + snapshot bars", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "qb-pf-"));
    try {
      const snap = buildMarketSnapshotRecord({
        asOf: "2026-08-04T00:00:00.000Z",
        purpose: "research",
        instruments: [{ symbol: "AAPL", venue: "US", assetClass: "equity" }],
        window: {},
        sources: [
          {
            provider: "yfinance",
            feed: "public_aggregate",
            upstreamFamily: "yfinance",
            feedClass: "L0_research_fallback",
            licenseUse: "research_only",
          },
        ],
        barsByInstrument: {
          "US:AAPL": [
            {
              open: 190,
              high: 192,
              low: 189,
              close: 191,
              volume: 10,
              turnover: 1910,
              timestamp: "2026-08-03T00:00:00.000Z",
            },
          ],
        },
        timeframe: "1d",
        limit: 5,
        createdAt: "2026-08-04T00:00:00.000Z",
      });
      const root = join(dataDir, "market-snapshots");
      await mkdir(root, { recursive: true });
      await writeFile(join(root, `${snap.snapshot.snapshotId}.json`), JSON.stringify(snap));

      const thesis = await writeResearchThesis(
        {
          snapshotId: snap.snapshot.snapshotId,
          instrumentScope: ["US:AAPL"],
          direction: "long",
          horizon: "5d",
          confidence: 0.7,
          modelAndPromptVersion: "pf/v1",
        },
        { dataDir }
      );

      const constructed = await constructTargetPortfolio(
        { thesisId: thesis.thesisId, capital: 100_000 },
        { dataDir }
      );
      expect(constructed.ok).toBe(true);
      expect(constructed.portfolio.thesisId).toBe(thesis.thesisId);
      expect(constructed.portfolio.snapshotId).toBe(snap.snapshot.snapshotId);
      expect(constructed.rows.length).toBeGreaterThan(0);
      expect(constructed.rows[0]?.symbol).toBe("AAPL");

      const book = await getForecastBookEntry(thesis.thesisId, dataDir);
      expect(book?.attribution.notes.some((n) => n.includes("portfolio.construct"))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
