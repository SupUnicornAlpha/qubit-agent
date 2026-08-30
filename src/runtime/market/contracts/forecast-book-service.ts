/**
 * Forecast book (Prime D4) — OUT harness attribution store.
 * Links thesis → risk / orders / fills / holding-period results.
 * Does not mutate order or risk state machines.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultDataDir } from "../../app-paths";
import { getResearchThesisById } from "./research-thesis-service";

export const ForecastHoldingResultSchema = z.object({
  horizon: z.string().min(1),
  realizedReturnPct: z.number().optional(),
  maxDrawdownPct: z.number().optional(),
  hitTarget: z.boolean().optional(),
  hitStop: z.boolean().optional(),
  evaluatedAt: z.string().optional(),
  status: z.enum(["open", "evaluated", "invalidated", "expired"]).default("open"),
  notes: z.array(z.string()).default([]),
});

export const ForecastAttributionSchema = z.object({
  modelAndPromptVersion: z.string().optional(),
  role: z.string().optional(),
  sourceProviders: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});

export const ForecastReflectionSchema = z.object({
  classification: z.enum(["confirmed", "invalidated", "inconclusive"]),
  reason: z.string().min(1),
  evaluatedAt: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  limitations: z.array(z.string()).default([]),
});

export const ForecastBookEntrySchema = z.object({
  entryId: z.string().min(1),
  thesisId: z.string().min(1),
  snapshotId: z.string().min(1),
  workflowRunId: z.string().nullable().default(null),
  recommendationId: z.string().nullable().default(null),
  riskDecisionIds: z.array(z.string()).default([]),
  orderIntentIds: z.array(z.string()).default([]),
  fillIds: z.array(z.string()).default([]),
  holdingPeriodResult: ForecastHoldingResultSchema.optional(),
  reflection: ForecastReflectionSchema.optional(),
  attribution: ForecastAttributionSchema.default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  schemaVersion: z.literal(1),
});
export type ForecastBookEntry = z.infer<typeof ForecastBookEntrySchema>;

const memoryCatalog = new Map<string, ForecastBookEntry>();

function bookRoot(dataDir?: string): string {
  return join(dataDir ?? defaultDataDir(), "forecast-book");
}

export function forecastEntryIdForThesis(thesisId: string): string {
  const digest = createHash("sha256").update(thesisId).digest("hex").slice(0, 24);
  return `fb_${digest}`;
}

export function clearForecastBookCatalogForTests(): void {
  memoryCatalog.clear();
}

export async function getForecastBookEntry(
  entryIdOrThesisId: string,
  dataDir?: string
): Promise<ForecastBookEntry | null> {
  const candidates = entryIdOrThesisId.startsWith("fb_")
    ? [entryIdOrThesisId]
    : [forecastEntryIdForThesis(entryIdOrThesisId), entryIdOrThesisId];

  for (const id of candidates) {
    const cached = memoryCatalog.get(id);
    if (cached) return cached;
    try {
      const path = join(bookRoot(dataDir), `${id}.json`);
      const raw = await readFile(path, "utf8");
      const parsed = ForecastBookEntrySchema.parse(JSON.parse(raw));
      memoryCatalog.set(parsed.entryId, parsed);
      return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

async function persistEntry(entry: ForecastBookEntry, dataDir?: string): Promise<void> {
  memoryCatalog.set(entry.entryId, entry);
  const root = bookRoot(dataDir);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, `${entry.entryId}.json`), JSON.stringify(entry), "utf8");
}

export async function ensureForecastBookForThesis(
  input: {
    thesisId: string;
    snapshotId?: string;
    workflowRunId?: string | null;
    role?: string | null;
    modelAndPromptVersion?: string | null;
  },
  options?: { dataDir?: string }
): Promise<ForecastBookEntry> {
  const existing = await getForecastBookEntry(input.thesisId, options?.dataDir);
  if (existing) return existing;

  const thesis = await getResearchThesisById(input.thesisId, options?.dataDir);
  const snapshotId = input.snapshotId ?? thesis?.thesis.snapshotId;
  if (!snapshotId) {
    throw new Error(`forecast_book_missing_snapshot:${input.thesisId}`);
  }

  const now = new Date().toISOString();
  const entry = ForecastBookEntrySchema.parse({
    entryId: forecastEntryIdForThesis(input.thesisId),
    thesisId: input.thesisId,
    snapshotId,
    workflowRunId: input.workflowRunId ?? thesis?.meta.workflowRunId ?? null,
    recommendationId: null,
    riskDecisionIds: [],
    orderIntentIds: [],
    fillIds: [],
    holdingPeriodResult: {
      horizon: thesis?.thesis.horizon ?? "unknown",
      status: "open",
      notes: [],
    },
    attribution: {
      modelAndPromptVersion:
        input.modelAndPromptVersion ?? thesis?.thesis.modelAndPromptVersion ?? undefined,
      role: input.role ?? thesis?.meta.role ?? undefined,
      sourceProviders: [],
      notes: [],
    },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  });
  await persistEntry(entry, options?.dataDir);
  return entry;
}

export type ForecastBookLinkPatch = {
  recommendationId?: string | null;
  riskDecisionIds?: string[];
  orderIntentIds?: string[];
  fillIds?: string[];
  holdingPeriodResult?: z.input<typeof ForecastHoldingResultSchema>;
  attributionNotes?: string[];
  sourceProviders?: string[];
};

function deriveReflection(
  result: z.infer<typeof ForecastHoldingResultSchema> | undefined,
  now: string
): z.infer<typeof ForecastReflectionSchema> | undefined {
  if (!result || !["evaluated", "invalidated", "expired"].includes(result.status)) return undefined;
  const classification =
    result.status === "invalidated" || result.hitStop === true
      ? "invalidated"
      : result.hitTarget === true && (result.realizedReturnPct ?? 0) > 0
        ? "confirmed"
        : "inconclusive";
  const reason =
    classification === "invalidated"
      ? "holding-period outcome reached an explicit stop or invalidation state"
      : classification === "confirmed"
        ? "holding-period outcome reached an explicit target with positive realized return"
        : "holding-period outcome is insufficient to confirm or invalidate the thesis";
  return {
    classification,
    reason,
    evaluatedAt: result.evaluatedAt ?? now,
    evidence: [
      `holding_status=${result.status}`,
      ...(result.realizedReturnPct !== undefined
        ? [`realized_return_pct=${result.realizedReturnPct}`]
        : []),
      ...(result.maxDrawdownPct !== undefined ? [`max_drawdown_pct=${result.maxDrawdownPct}`] : []),
    ],
    limitations: [
      "outcome classification is not causal attribution",
      "single holding-period result does not validate a framework or strategy",
    ],
  };
}

/** Idempotent merge of link fields — never removes existing ids. */
export async function linkForecastBookEntry(
  thesisId: string,
  patch: ForecastBookLinkPatch,
  options?: { dataDir?: string }
): Promise<ForecastBookEntry> {
  const base = await ensureForecastBookForThesis({ thesisId }, options);
  const now = new Date().toISOString();
  const uniq = (values: string[]) => [...new Set(values.filter(Boolean))];

  const holdingPeriodResult = patch.holdingPeriodResult
    ? ForecastHoldingResultSchema.parse({
        ...base.holdingPeriodResult,
        ...patch.holdingPeriodResult,
      })
    : base.holdingPeriodResult;
  const reflection = deriveReflection(holdingPeriodResult, now);
  const entry = ForecastBookEntrySchema.parse({
    ...base,
    recommendationId: patch.recommendationId ?? base.recommendationId,
    riskDecisionIds: uniq([...base.riskDecisionIds, ...(patch.riskDecisionIds ?? [])]),
    orderIntentIds: uniq([...base.orderIntentIds, ...(patch.orderIntentIds ?? [])]),
    fillIds: uniq([...base.fillIds, ...(patch.fillIds ?? [])]),
    holdingPeriodResult,
    ...(reflection ? { reflection } : {}),
    attribution: {
      ...base.attribution,
      sourceProviders: uniq([
        ...(base.attribution.sourceProviders ?? []),
        ...(patch.sourceProviders ?? []),
      ]),
      notes: uniq([...(base.attribution.notes ?? []), ...(patch.attributionNotes ?? [])]),
    },
    updatedAt: now,
  });

  await persistEntry(entry, options?.dataDir);
  return entry;
}
