import {
  ensureForecastBookForThesis,
  getForecastBookEntry,
  linkForecastBookEntry,
} from "../market/contracts/forecast-book-service";
import { getOrCreateMarketSnapshot } from "../market/contracts/market-snapshot-service";
import { constructTargetPortfolio } from "../market/contracts/portfolio-construct-service";
import {
  isResearchThesisWriteEnabled,
  writeResearchThesis,
} from "../market/contracts/research-thesis-service";
import {
  coerceConfidence01,
  extractForecastBookKey,
  extractSnapshotId,
  normalizePortfolioCandidates,
  resolveInstrumentScope,
  resolveThesisDirection,
} from "./research-arg-normalize";
import { applyToolContract, isToolContractEnabled } from "./tool-contract";
import { getToolContract } from "./tool-contract-registry";
import type { BuiltinToolHandler } from "./types";

function unboundSnapshotId(symbols: string[], direction: string): string {
  const key = [...symbols].sort().join("|") || "unknown";
  let h = 0;
  const s = `${key}:${direction}`;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return `mkt_snapshot_unbound_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(String)
    .map((s) => s.trim())
    .filter(Boolean);
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
      counterEvidenceRefs: asStringArray(row.counterEvidenceRefs ?? row.counter_evidence_refs),
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
    const contract = isToolContractEnabled() ? getToolContract("research.thesis.write") : undefined;
    const canonical = contract ? applyToolContract(contract, params) : params;

    const symbols = resolveInstrumentScope(canonical);
    if (symbols.length === 0) {
      throw new Error(
        "research.thesis.write: instrumentScope/symbols is required（也可写在 narrative 里如 600519.SH / AAPL）"
      );
    }

    const direction = resolveThesisDirection(canonical);
    const confidence = coerceConfidence01(canonical.confidence, 0.5);

    let snapshotId =
      String(canonical.snapshotId ?? canonical.snapshot_id ?? "").trim() ||
      extractSnapshotId(canonical);
    let snapshotBinding: "explicit" | "auto" | "unbound" = snapshotId ? "explicit" : "auto";
    let snapshotWarning: string | undefined;

    if (!snapshotId) {
      try {
        const snap = await withTimeout(
          getOrCreateMarketSnapshot({
            symbols,
            purpose: "research",
            timeframe: "1d",
            limit: 60,
          }),
          2_500,
          "snapshot_auto"
        );
        snapshotId = snap.snapshotId;
        snapshotBinding = "auto";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        snapshotId = unboundSnapshotId(symbols, direction);
        snapshotBinding = "unbound";
        snapshotWarning =
          `snapshot 自动拉取失败（${msg}）；已用 unbound snapshotId=${snapshotId} 落库 thesis。` +
          "后续请补 market.snapshot.get 并在 evidence 中引用真实 mkt_snapshot_*。";
      }
    }

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
      snapshotBinding,
      ...(snapshotWarning ? { warning: snapshotWarning } : {}),
      forecastBookEntryId: book.entryId,
      forecastBookStatus: book.holdingPeriodResult?.status ?? "open",
    };
  },

  "research.forecast_book.get": async (_ctx, params) => {
    const { thesisId, entryId } = extractForecastBookKey(params);
    const key = entryId || thesisId;
    if (!key) {
      throw new Error(
        "research.forecast_book.get: thesisId、entryId 或 bookId(fb_*) 必填其一（thesis.write 返回的 thesisId / forecastBookEntryId）"
      );
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

    const loose = normalizePortfolioCandidates(params);
    const candidates = loose
      ? loose.map((row) => ({
          symbol: row.symbol,
          side: row.side,
          // price 0 → service fills from snapshot bars / default
          price: row.price > 0 ? row.price : 0,
          confidence: row.confidence,
          stopLoss: row.stopLoss,
          currentQty: row.currentQty,
          sector: row.sector,
          proposedWeight: row.proposedWeight,
        }))
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
