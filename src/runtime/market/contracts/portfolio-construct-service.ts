/**
 * Deterministic portfolio construct bound to thesis + snapshot (Prime D5).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  allocatePortfolio,
  type PortfolioAllocationConfig,
  type PortfolioCandidate,
  type PortfolioAllocationRow,
  type PortfolioExposureReport,
} from "../../execution/portfolio-allocation-service";
import { getResearchThesisById } from "./research-thesis-service";
import { getMarketSnapshotById } from "./market-snapshot-service";
import { ensureForecastBookForThesis, linkForecastBookEntry } from "./forecast-book-service";

export const TargetPortfolioSchema = z.object({
  portfolioId: z.string().min(1),
  thesisId: z.string().min(1),
  snapshotId: z.string().min(1),
  capital: z.number().positive(),
  rows: z.array(z.record(z.unknown())),
  exposures: z.record(z.unknown()),
  riskReportRef: z.string().optional(),
  createdAt: z.string().min(1),
  schemaVersion: z.literal(1),
});
export type TargetPortfolio = z.infer<typeof TargetPortfolioSchema>;

export type PortfolioConstructInput = {
  thesisId: string;
  snapshotId?: string;
  capital: number;
  candidates?: PortfolioCandidate[];
  config?: Omit<PortfolioAllocationConfig, "capital">;
  workflowRunId?: string | null;
};

export type PortfolioConstructResult = {
  ok: true;
  portfolio: TargetPortfolio;
  rows: PortfolioAllocationRow[];
  exposures: PortfolioExposureReport;
  summary: string;
};

function portfolioIdFor(thesisId: string, snapshotId: string, capital: number): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ thesisId, snapshotId, capital }))
    .digest("hex")
    .slice(0, 24);
  return `pf_${digest}`;
}

function candidatesFromThesis(input: {
  thesisId: string;
  direction: "long" | "short" | "neutral";
  instrumentScope: string[];
  confidence: number;
  barsByInstrument?: Record<string, Array<{ close: number }>>;
}): PortfolioCandidate[] {
  if (input.direction === "neutral") return [];
  const side = input.direction === "short" ? "short" : "long";
  return input.instrumentScope.map((key) => {
    const symbol = key.includes(":") ? key.split(":").slice(1).join(":") : key;
    const bars = input.barsByInstrument?.[key] ?? [];
    const price = bars.at(-1)?.close;
    return {
      symbol,
      side,
      price: Number.isFinite(price) && (price as number) > 0 ? (price as number) : 100,
      confidence: input.confidence,
      currentQty: 0,
    };
  });
}

export async function constructTargetPortfolio(
  input: PortfolioConstructInput,
  options?: { dataDir?: string }
): Promise<PortfolioConstructResult> {
  const thesisId = input.thesisId.trim();
  if (!thesisId) throw new Error("portfolio.construct: thesisId is required");
  if (!Number.isFinite(input.capital) || input.capital <= 0) {
    throw new Error("portfolio.construct: capital must be positive");
  }

  const thesis = await getResearchThesisById(thesisId, options?.dataDir);
  if (!thesis) throw new Error(`thesis_not_found:${thesisId}`);

  const snapshotId = (input.snapshotId?.trim() || thesis.thesis.snapshotId).trim();
  if (input.snapshotId?.trim() && input.snapshotId.trim() !== thesis.thesis.snapshotId) {
    throw new Error(
      `snapshot_thesis_mismatch:${input.snapshotId.trim()}!=${thesis.thesis.snapshotId}`
    );
  }

  const snapshot = await getMarketSnapshotById(snapshotId, options?.dataDir);
  // Snapshot may be missing in pure unit tests that only have thesis; candidates can still be explicit.
  const barsByInstrument = snapshot?.barsByInstrument ?? {};

  let candidates =
    input.candidates && input.candidates.length > 0
      ? input.candidates
      : candidatesFromThesis({
          thesisId,
          direction: thesis.thesis.direction,
          instrumentScope: thesis.thesis.instrumentScope,
          confidence: thesis.thesis.confidence,
          barsByInstrument,
        });

  // Fill missing/zero prices from snapshot bars (models often pass allocation weights only).
  candidates = candidates.map((c) => {
    if (c.price > 0) return c;
    const keys = [c.symbol, `CN:${c.symbol}`, `US:${c.symbol}`, `HK:${c.symbol}`];
    let price = 0;
    for (const key of keys) {
      const bars = barsByInstrument[key];
      const close = bars?.at(-1)?.close;
      if (Number.isFinite(close) && (close as number) > 0) {
        price = close as number;
        break;
      }
    }
    return { ...c, price: price > 0 ? price : 100 };
  }).filter((c) => c.symbol);

  if (candidates.length === 0) {
    throw new Error(
      "portfolio.construct: no candidates — neutral thesis 必须传 candidates[] 或 allocation[{symbol,weight}]；" +
        "long/short thesis 需 instrumentScope 非空。勿只传 allocation 却省略 symbol。"
    );
  }

  const allocated = allocatePortfolio(candidates, {
    capital: input.capital,
    ...(input.config ?? {}),
  });

  const createdAt = new Date().toISOString();
  const portfolio = TargetPortfolioSchema.parse({
    portfolioId: portfolioIdFor(thesisId, snapshotId, input.capital),
    thesisId,
    snapshotId,
    capital: input.capital,
    rows: allocated.rows as unknown as Record<string, unknown>[],
    exposures: allocated.exposures as unknown as Record<string, unknown>,
    riskReportRef: `risk_${portfolioIdFor(thesisId, snapshotId, input.capital)}`,
    createdAt,
    schemaVersion: 1,
  });

  await ensureForecastBookForThesis(
    {
      thesisId,
      snapshotId,
      workflowRunId: input.workflowRunId ?? thesis.meta.workflowRunId,
      role: thesis.meta.role,
      modelAndPromptVersion: thesis.thesis.modelAndPromptVersion,
    },
    options
  );
  await linkForecastBookEntry(
    thesisId,
    {
      attributionNotes: [`portfolio.construct:${portfolio.portfolioId}`],
      sourceProviders: snapshot?.snapshot.sources.map((s) => s.provider) ?? [],
    },
    options
  );

  return {
    ok: true,
    portfolio,
    rows: allocated.rows,
    exposures: allocated.exposures,
    summary: `已构建绑定 thesis=${thesisId} 的目标组合 ${portfolio.portfolioId}`,
  };
}
