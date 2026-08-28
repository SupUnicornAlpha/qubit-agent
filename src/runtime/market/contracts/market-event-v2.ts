/**
 * Market Event Contract v2 + snapshot / quality / thesis schemas (Prime D0).
 * Protocol for the market data plane — not Core business logic.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const MARKET_EVENT_SCHEMA_VERSION = 2 as const;

export const MarketEventKindSchema = z.enum([
  "quote",
  "trade",
  "book_delta",
  "bar",
  "corporate_action",
  "news",
  "gap",
  "status",
]);
export type MarketEventKind = z.infer<typeof MarketEventKindSchema>;

export const MarketAssetClassSchema = z.enum([
  "equity",
  "etf",
  "index",
  "future",
  "option",
  "crypto",
  "fx",
  "bond",
  "unknown",
]);
export type MarketAssetClass = z.infer<typeof MarketAssetClassSchema>;

export const MarketInstrumentSchema = z.object({
  symbol: z.string().min(1),
  venue: z.string().min(1),
  assetClass: MarketAssetClassSchema.default("unknown"),
});
export type MarketInstrument = z.infer<typeof MarketInstrumentSchema>;

export const MarketFeedClassSchema = z.enum([
  "L0_research_fallback",
  "L1_strategy_validation",
  "L2_realtime_observe",
  "L3_trading",
]);
export type MarketFeedClass = z.infer<typeof MarketFeedClassSchema>;

export const MarketLicenseUseSchema = z.enum([
  "trading_allowed",
  "research_only",
  "observe_only",
  "denied",
]);
export type MarketLicenseUse = z.infer<typeof MarketLicenseUseSchema>;

export const MarketEventSourceSchema = z.object({
  provider: z.string().min(1),
  feed: z.string().min(1),
  upstreamFamily: z.string().min(1),
  feedClass: MarketFeedClassSchema.optional(),
  licenseUse: MarketLicenseUseSchema.optional(),
});
export type MarketEventSource = z.infer<typeof MarketEventSourceSchema>;

export const MarketEventSequenceSchema = z.object({
  channel: z.string().min(1),
  value: z.number().int().nonnegative().nullable(),
  isContiguous: z.boolean().nullable(),
  providerSequenceAvailable: z.boolean().default(false),
});
export type MarketEventSequence = z.infer<typeof MarketEventSequenceSchema>;

export const MarketEventQualityStateSchema = z.enum([
  "verified",
  "observed",
  "stale",
  "gap_pending",
  "divergent",
  "malformed",
  "research_only",
]);
export type MarketEventQualityState = z.infer<typeof MarketEventQualityStateSchema>;

export const MarketEventQualitySchema = z.object({
  state: MarketEventQualityStateSchema,
  freshnessMs: z.number().finite().nonnegative().nullable(),
  revision: z.number().int().nonnegative().default(0),
  supersedes: z.string().optional(),
});
export type MarketEventQuality = z.infer<typeof MarketEventQualitySchema>;

export const MarketEventSchema = z.object({
  eventId: z.string().min(1),
  kind: MarketEventKindSchema,
  instrument: MarketInstrumentSchema,
  eventTs: z.string().min(1),
  recvTs: z.string().min(1),
  source: MarketEventSourceSchema,
  sequence: MarketEventSequenceSchema,
  schemaVersion: z.literal(MARKET_EVENT_SCHEMA_VERSION),
  payload: z.record(z.unknown()).default({}),
  rawPayloadHash: z.string().min(1),
  quality: MarketEventQualitySchema,
  ingestedAt: z.string().min(1),
});
export type MarketEventV2 = z.infer<typeof MarketEventSchema>;

export const DataQualityFreshnessSchema = z.enum(["fresh", "stale", "unknown"]);
export const DataQualityCompletenessSchema = z.enum([
  "complete",
  "gap_pending",
  "gap_unrecoverable",
]);
export const DataQualityConsistencySchema = z.enum(["verified", "divergent", "insufficient_peers"]);
export const DataQualityStructureSchema = z.enum(["valid", "malformed", "market_closed"]);
export const DataQualityPitSchema = z.enum(["point_in_time_valid", "invalid"]);

/** Explicit daily session state from a versioned exchange calendar. */
export const MarketCalendarSessionStateSchema = z.enum(["open", "closed"]);
export type MarketCalendarSessionState = z.infer<typeof MarketCalendarSessionStateSchema>;
export const MarketCalendarSessionsByVenueSchema = z.record(
  z.record(MarketCalendarSessionStateSchema)
);
export type MarketCalendarSessionsByVenue = z.infer<typeof MarketCalendarSessionsByVenueSchema>;

/**
 * Frozen point-in-time membership intervals for a research universe. The source table must
 * describe membership changes rather than only the symbols that survive in today's universe.
 */
export const MarketUniverseHistorySchema = z.object({
  universeId: z.string().min(1),
  version: z.string().min(1),
  source: z.string().min(1),
  asOf: z.string().min(1),
  membershipIntervals: z
    .array(
      z.object({
        symbol: z.string().min(1),
        startDate: z.string().min(1),
        endDate: z.string().min(1).optional(),
      })
    )
    .min(1),
});
export type MarketUniverseHistory = z.infer<typeof MarketUniverseHistorySchema>;

/** Corporate-action ledger with the time at which each action became usable. */
export const MarketCorporateActionSchema = z.object({
  kind: z.enum([
    "cash_dividend",
    "stock_dividend",
    "split",
    "merger",
    "spinoff",
    "delisting",
    "symbol_change",
    "other",
  ]),
  effectiveDate: z.string().min(1),
  knownAt: z.string().min(1),
  ratio: z.number().finite().positive().optional(),
  cashAmount: z.number().finite().optional(),
  reference: z.string().min(1).optional(),
});
export type MarketCorporateAction = z.infer<typeof MarketCorporateActionSchema>;

export const MarketCorporateActionLedgerSchema = z.object({
  version: z.string().min(1),
  source: z.string().min(1),
  asOf: z.string().min(1),
  /** Must match the snapshot adjustment method; empty arrays are explicit no-action evidence. */
  adjustmentMethod: z.string().min(1),
  actionsBySymbol: z.record(z.array(MarketCorporateActionSchema)),
});
export type MarketCorporateActionLedger = z.infer<typeof MarketCorporateActionLedgerSchema>;

/**
 * A scalar fundamental observation as it was first available to the market.
 * `fiscalPeriodEnd` is the economic period being measured; it is deliberately
 * distinct from `availableAt`, which is the only timestamp a backtest may use
 * when deciding whether this revision was observable.
 */
export const MarketFundamentalObservationSchema = z.object({
  metric: z.string().min(1),
  fiscalPeriodEnd: z.string().min(1),
  availableAt: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1).optional(),
  revisionId: z.string().min(1).optional(),
  supersedesRevisionId: z.string().min(1).optional(),
  reference: z.string().min(1).optional(),
});
export type MarketFundamentalObservation = z.infer<typeof MarketFundamentalObservationSchema>;

/**
 * Versioned, point-in-time financial statement / estimate ledger. Every
 * revision is retained; consumers must select only observations available at
 * their decision timestamp instead of substituting today's restated values.
 */
export const MarketFundamentalLedgerSchema = z.object({
  version: z.string().min(1),
  source: z.string().min(1),
  asOf: z.string().min(1),
  observationsBySymbol: z.record(z.array(MarketFundamentalObservationSchema)),
});
export type MarketFundamentalLedger = z.infer<typeof MarketFundamentalLedgerSchema>;

export const DataQualityVerdictSchema = z.object({
  instrument: MarketInstrumentSchema,
  feed: z.string().min(1),
  kind: MarketEventKindSchema,
  asOf: z.string().min(1),
  freshness: DataQualityFreshnessSchema,
  completeness: DataQualityCompletenessSchema,
  consistency: DataQualityConsistencySchema,
  structure: DataQualityStructureSchema,
  pointInTime: DataQualityPitSchema,
  licenseUse: MarketLicenseUseSchema,
  tradable: z.boolean(),
  useClass: z.enum(["trading", "research_only", "observe_only", "denied"]),
  reasons: z.array(z.string()).default([]),
  snapshotId: z.string().optional(),
});
export type DataQualityVerdict = z.infer<typeof DataQualityVerdictSchema>;

export const MarketSnapshotSchema = z.object({
  snapshotId: z.string().min(1),
  asOf: z.string().min(1),
  purpose: z.enum(["research", "backtest", "observe", "trading", "risk"]),
  universe: z.array(z.string().min(1)).min(1),
  window: z
    .object({
      start: z.string().optional(),
      end: z.string().optional(),
    })
    .default({}),
  sources: z.array(MarketEventSourceSchema).min(1),
  sourceRevisions: z.record(z.number().int().nonnegative()).default({}),
  qualityVerdict: DataQualityVerdictSchema.optional(),
  adjustMethod: z.string().optional(),
  universeHistory: MarketUniverseHistorySchema.optional(),
  corporateActionLedger: MarketCorporateActionLedgerSchema.optional(),
  fundamentalLedger: MarketFundamentalLedgerSchema.optional(),
  timezone: z.string().default("UTC"),
  calendarVersion: z.string().optional(),
  calendarSessionsByVenue: MarketCalendarSessionsByVenueSchema.optional(),
  eventRefs: z.array(z.string()).default([]),
  createdAt: z.string().min(1),
  schemaVersion: z.literal(MARKET_EVENT_SCHEMA_VERSION),
});
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>;

export const ResearchThesisClaimSchema = z.object({
  claim: z.string().min(1),
  evidenceRefs: z.array(z.string()).default([]),
  counterEvidenceRefs: z.array(z.string()).default([]),
});

export const ResearchThesisSchema = z.object({
  thesisId: z.string().min(1),
  snapshotId: z.string().min(1),
  instrumentScope: z.array(z.string().min(1)).min(1),
  direction: z.enum(["long", "short", "neutral"]),
  horizon: z.string().min(1),
  confidence: z.number().min(0).max(1),
  claims: z.array(ResearchThesisClaimSchema).default([]),
  invalidation: z
    .array(
      z.object({
        condition: z.string().min(1),
        observable: z.string().min(1),
      })
    )
    .default([]),
  knownUnknowns: z.array(z.string()).default([]),
  modelAndPromptVersion: z.string().min(1),
  createdAt: z.string().min(1),
});
export type ResearchThesis = z.infer<typeof ResearchThesisSchema>;

/** Evaluate tradability — fail closed for trading. */
export function evaluateTradability(
  input: Omit<DataQualityVerdict, "tradable" | "useClass" | "reasons"> & {
    reasons?: string[];
  }
): DataQualityVerdict {
  const reasons = [...(input.reasons ?? [])];
  const allowed =
    input.licenseUse === "trading_allowed" &&
    input.freshness === "fresh" &&
    input.completeness === "complete" &&
    input.pointInTime === "point_in_time_valid" &&
    input.consistency !== "divergent" &&
    input.structure === "valid";

  if (input.licenseUse !== "trading_allowed") reasons.push(`license:${input.licenseUse}`);
  if (input.freshness !== "fresh") reasons.push(`freshness:${input.freshness}`);
  if (input.completeness !== "complete") reasons.push(`completeness:${input.completeness}`);
  if (input.pointInTime !== "point_in_time_valid") reasons.push(`pit:${input.pointInTime}`);
  if (input.consistency === "divergent") reasons.push("consistency:divergent");
  if (input.structure !== "valid") reasons.push(`structure:${input.structure}`);

  let useClass: DataQualityVerdict["useClass"] = "denied";
  if (allowed) useClass = "trading";
  else if (input.licenseUse === "denied") useClass = "denied";
  else if (input.licenseUse === "observe_only" || input.freshness === "stale")
    useClass = "observe_only";
  else useClass = "research_only";

  return DataQualityVerdictSchema.parse({
    ...input,
    tradable: allowed,
    useClass,
    reasons,
  });
}

export function hashPayload(payload: unknown): string {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload ?? null);
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function newMarketEventId(prefix = "mev"): string {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(6).toString("hex");
  return `${prefix}_${stamp}_${rand}`;
}

export function newSnapshotId(prefix = "mkt_snapshot"): string {
  return newMarketEventId(prefix);
}

export function newThesisId(prefix = "thesis"): string {
  return newMarketEventId(prefix);
}
