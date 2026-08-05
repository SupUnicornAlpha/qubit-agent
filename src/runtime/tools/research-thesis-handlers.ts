import { extractSymbolArgs } from "../market/normalize-symbol-args";
import {
  ensureForecastBookForThesis,
  getForecastBookEntry,
  linkForecastBookEntry,
} from "../market/contracts/forecast-book-service";
import { constructTargetPortfolio } from "../market/contracts/portfolio-construct-service";
import {
  isResearchThesisWriteEnabled,
  writeResearchThesis,
} from "../market/contracts/research-thesis-service";
import { applyToolContract, isToolContractEnabled } from "./tool-contract";
import { getToolContract } from "./tool-contract-registry";
import type { BuiltinToolHandler } from "./types";

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((s) => s.trim()).filter(Boolean);
}

function parseClaims(raw: unknown): Array<{
  claim: string;
  evidenceRefs: string[];
  counterEvidenceRefs: string[];
}> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{
    claim: string;
    evidenceRefs: string[];
    counterEvidenceRefs: string[];
  }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const claim = String(row.claim ?? "").trim();
    if (!claim) continue;
    out.push({
      claim,
      evidenceRefs: asStringArray(row.evidenceRefs ?? row.evidence_refs),
      counterEvidenceRefs: asStringArray(
        row.counterEvidenceRefs ?? row.counter_evidence_refs
      ),
    });
  }
  return out;
}

function parseInvalidation(raw: unknown): Array<{ condition: string; observable: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ condition: string; observable: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const condition = String(row.condition ?? "").trim();
    const observable = String(row.observable ?? "").trim();
    if (!condition || !observable) continue;
    out.push({ condition, observable });
  }
  return out;
}

/** Structured research thesis + forecast book tools (Prime D4). */
export const RESEARCH_THESIS_HANDLERS: Record<string, BuiltinToolHandler> = {
  "research.thesis.write": async (ctx, params) => {
    if (!isResearchThesisWriteEnabled()) {
      throw new Error("research.thesis.write is disabled (QUBIT_RESEARCH_THESIS_WRITE=0)");
    }
    const contract = isToolContractEnabled()
      ? getToolContract("research.thesis.write")
      : undefined;
    const canonical = contract ? applyToolContract(contract, params) : params;

    const snapshotId = String(canonical.snapshotId ?? canonical.snapshot_id ?? "").trim();
    if (!snapshotId) {
      throw new Error("research.thesis.write: snapshotId is required (call market.snapshot.get first)");
    }

    const scopeFromParam = asStringArray(
      canonical.instrumentScope ?? canonical.instrument_scope ?? canonical.universe
    );
    const symbols = scopeFromParam.length > 0 ? scopeFromParam : extractSymbolArgs(canonical);
    if (symbols.length === 0) {
      throw new Error(
        "research.thesis.write: instrumentScope/symbols is required"
      );
    }

    const directionRaw = String(canonical.direction ?? "neutral")
      .trim()
      .toLowerCase();
    const direction =
      directionRaw === "long" || directionRaw === "short" || directionRaw === "neutral"
        ? directionRaw
        : null;
    if (!direction) {
      throw new Error("research.thesis.write: direction must be long|short|neutral");
    }

    const confidence = Number(canonical.confidence ?? 0.5);
    const written = await writeResearchThesis({
      snapshotId,
      instrumentScope: symbols,
      direction,
      horizon: String(canonical.horizon ?? "5d"),
      confidence,
      claims: parseClaims(canonical.claims),
      invalidation: parseInvalidation(canonical.invalidation),
      knownUnknowns: asStringArray(canonical.knownUnknowns ?? canonical.known_unknowns),
      modelAndPromptVersion: String(
        canonical.modelAndPromptVersion ??
          canonical.model_and_prompt_version ??
          ctx.definition.version ??
          "unknown"
      ),
      thesisId:
        typeof canonical.thesisId === "string"
          ? canonical.thesisId
          : typeof canonical.thesis_id === "string"
            ? canonical.thesis_id
            : undefined,
      workflowRunId: ctx.workflowId,
      role: ctx.definition.role,
    });

    const book = await ensureForecastBookForThesis({
      thesisId: written.thesisId,
      snapshotId: written.snapshotId,
      workflowRunId: ctx.workflowId,
      role: ctx.definition.role,
      modelAndPromptVersion: written.thesis.modelAndPromptVersion,
    });

    return {
      ...written,
      forecastBookEntryId: book.entryId,
      forecastBookStatus: book.holdingPeriodResult?.status ?? "open",
    };
  },

  "research.forecast_book.get": async (_ctx, params) => {
    const thesisId = String(params.thesisId ?? params.thesis_id ?? "").trim();
    const entryId = String(params.entryId ?? params.entry_id ?? "").trim();
    const key = entryId || thesisId;
    if (!key) {
      throw new Error("research.forecast_book.get: thesisId or entryId is required");
    }
    const entry = await getForecastBookEntry(key);
    if (!entry) throw new Error(`forecast_book_not_found:${key}`);
    return { ok: true, entry };
  },

  "research.forecast_book.link": async (_ctx, params) => {
    const thesisId = String(params.thesisId ?? params.thesis_id ?? "").trim();
    if (!thesisId) {
      throw new Error("research.forecast_book.link: thesisId is required");
    }
    const entry = await linkForecastBookEntry(thesisId, {
      recommendationId:
        typeof params.recommendationId === "string"
          ? params.recommendationId
          : typeof params.recommendation_id === "string"
            ? params.recommendation_id
            : undefined,
      riskDecisionIds: asStringArray(params.riskDecisionIds ?? params.risk_decision_ids),
      orderIntentIds: asStringArray(params.orderIntentIds ?? params.order_intent_ids),
      fillIds: asStringArray(params.fillIds ?? params.fill_ids),
      sourceProviders: asStringArray(params.sourceProviders ?? params.source_providers),
      attributionNotes: asStringArray(params.notes ?? params.attributionNotes),
      holdingPeriodResult:
        params.holdingPeriodResult &&
        typeof params.holdingPeriodResult === "object" &&
        !Array.isArray(params.holdingPeriodResult)
          ? (params.holdingPeriodResult as Record<string, unknown>)
          : undefined,
    });
    return {
      ok: true,
      entryId: entry.entryId,
      thesisId: entry.thesisId,
      linked: {
        recommendationId: entry.recommendationId,
        riskDecisionIds: entry.riskDecisionIds,
        orderIntentIds: entry.orderIntentIds,
        fillIds: entry.fillIds,
      },
      holdingPeriodResult: entry.holdingPeriodResult,
      updatedAt: entry.updatedAt,
    };
  },

  "portfolio.construct": async (ctx, params) => {
    const thesisId = String(params.thesisId ?? params.thesis_id ?? "").trim();
    if (!thesisId) {
      throw new Error("portfolio.construct: thesisId is required");
    }
    const capital = Number(params.capital ?? params.notional ?? 100_000);
    const snapshotId =
      typeof params.snapshotId === "string"
        ? params.snapshotId
        : typeof params.snapshot_id === "string"
          ? params.snapshot_id
          : undefined;

    const candidatesRaw = Array.isArray(params.candidates) ? params.candidates : null;
    const candidates = candidatesRaw
      ? candidatesRaw
          .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
          .map((row) => ({
            symbol: String(row.symbol ?? "").trim().toUpperCase(),
            side: (String(row.side ?? "long").toLowerCase() === "short" ? "short" : "long") as
              | "long"
              | "short",
            price: Number(row.price ?? 0),
            confidence: Number(row.confidence ?? 0.5),
            stopLoss:
              row.stopLoss != null && Number.isFinite(Number(row.stopLoss))
                ? Number(row.stopLoss)
                : null,
            currentQty: Number(row.currentQty ?? 0),
            sector: typeof row.sector === "string" ? row.sector : null,
          }))
          .filter((row) => row.symbol && row.price > 0)
      : undefined;

    const constructed = await constructTargetPortfolio({
      thesisId,
      snapshotId,
      capital,
      candidates,
      workflowRunId: ctx.workflowId,
      config: {
        grossLimit:
          params.grossLimit != null && Number.isFinite(Number(params.grossLimit))
            ? Number(params.grossLimit)
            : undefined,
        netLimit:
          params.netLimit != null && Number.isFinite(Number(params.netLimit))
            ? Number(params.netLimit)
            : undefined,
        perPositionMax:
          params.perPositionMax != null && Number.isFinite(Number(params.perPositionMax))
            ? Number(params.perPositionMax)
            : undefined,
      },
    });

    return {
      ...constructed,
      effects: [
        {
          kind: "target_portfolio",
          key: constructed.portfolio.portfolioId,
          meta: {
            thesisId: constructed.portfolio.thesisId,
            snapshotId: constructed.portfolio.snapshotId,
          },
        },
      ],
    };
  },
};
