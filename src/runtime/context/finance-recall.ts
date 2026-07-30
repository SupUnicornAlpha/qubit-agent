/**
 * FinanceRecall — Context Protocol A2/A4/A5/A6
 *
 * 在 ExperienceRecall 池上做 finance 过滤 + 合分重排：
 *   score = 0.30*relevancy + 0.20*recency + 0.20*importance
 *         + 0.20*outcomeWeight + 0.10*domainBoost
 */

import type { Experience } from "../../types/entities";
import {
  ExperienceRecall,
  type RecallContext,
  type RecallEngineOptions,
  type RecallResult,
  keywordScore,
  recencyScore,
  tokenize,
} from "../experience/pipes/recall";
import { isPitCutoffEnabled } from "./axioms";
import { incContextMetric } from "./context-metrics";
import {
  FINANCE_RECALL_PREFER_SUB_KINDS,
  type FinanceSubKind,
} from "./types";

export interface FinanceRecallContext extends RecallContext {
  symbols?: string[];
  decisionCutoff?: string;
  preferSubKinds?: FinanceSubKind[];
}

export interface FinanceRecallResult extends RecallResult {
  components: RecallResult["components"] & {
    importance: number;
    outcomeWeight: number;
    domainBoost: number;
  };
}

const W_REL = 0.3;
const W_REC = 0.2;
const W_IMP = 0.2;
const W_OUT = 0.2;
const W_DOM = 0.1;

const TIER_IMPORTANCE: Record<string, number> = {
  shallow: 0.3,
  intermediate: 0.6,
  deep: 0.85,
};

export class FinanceRecall {
  private readonly base: ExperienceRecall;
  private readonly now: () => Date;

  constructor(opts: RecallEngineOptions) {
    this.base = new ExperienceRecall(opts);
    this.now = opts.now ?? (() => new Date());
  }

  async recall(ctx: FinanceRecallContext): Promise<FinanceRecallResult[]> {
    const prefer = ctx.preferSubKinds ?? FINANCE_RECALL_PREFER_SUB_KINDS;
    const pool = await this.base.recall({
      ...ctx,
      kinds: ["semantic", "procedural"],
      topK: Math.max(ctx.topK ?? 5, 20),
      silentEmit: true,
    });

    const tokens = tokenize(ctx.query);
    const cutoff = isPitCutoffEnabled() ? ctx.decisionCutoff : undefined;
    let pitFiltered = 0;
    let expiredSnap = 0;
    const rescored: FinanceRecallResult[] = [];

    for (const hit of pool) {
      const exp = hit.experience;
      if (!prefer.includes(exp.subKind as FinanceSubKind)) continue;

      const meta = exp.metadataJson ?? {};
      const asof = typeof meta["asof"] === "string" ? meta["asof"] : null;

      if (cutoff && asof && asof.slice(0, 10) > cutoff.slice(0, 10)) {
        pitFiltered += 1;
        continue;
      }

      if (exp.subKind === "market_snapshot") {
        const decayHours =
          typeof meta["decayHours"] === "number" ? meta["decayHours"] : 48;
        const from = new Date(exp.validFrom).getTime();
        if (
          Number.isFinite(from) &&
          this.now().getTime() - from > decayHours * 3_600_000
        ) {
          expiredSnap += 1;
          continue;
        }
      }

      if (exp.subKind === "factor_archive" && !meta["factorId"]) {
        incContextMetric("finance.orphan_archive_rate", 1);
        continue;
      }
      if (exp.subKind === "strategy_recipe" && !meta["compositionId"]) continue;
      if (
        exp.subKind === "research_conclusion" &&
        (!Array.isArray(meta["symbols"]) || meta["symbols"].length === 0)
      ) {
        continue;
      }

      rescored.push(this.scoreFinance(exp, hit, tokens, ctx.symbols));
    }

    if (pitFiltered > 0) incContextMetric("finance.pit_filtered", pitFiltered);
    if (expiredSnap > 0) incContextMetric("finance.snapshot_expired_drop", expiredSnap);

    rescored.sort((a, b) => b.score - a.score);
    const topK = ctx.topK ?? 5;
    const top = rescored.slice(0, topK);
    top.forEach((r, i) => {
      r.rank = i;
    });

    const withRef = top.filter((r) => {
      const m = r.experience.metadataJson ?? {};
      return Boolean(m["factorId"] || m["compositionId"]);
    }).length;
    if (top.length > 0) {
      incContextMetric("finance.recall_hit_with_ref", withRef);
      incContextMetric("finance.recall_hits", top.length);
      const avgOut =
        top.reduce((s, r) => s + r.components.outcomeWeight, 0) / top.length;
      incContextMetric("finance.recall_outcome_weight_avg", Math.round(avgOut * 1000));
    }

    return top;
  }

  private scoreFinance(
    exp: Experience,
    baseHit: RecallResult,
    tokens: string[],
    symbols: string[] | undefined
  ): FinanceRecallResult {
    const meta = exp.metadataJson ?? {};
    const haystack = [
      exp.contentJson.summary ?? "",
      String(exp.contentJson.body ?? ""),
      exp.tagsJson.join(" "),
      exp.subKind,
      JSON.stringify(meta),
    ].join(" ");

    const relevancy = Math.max(
      baseHit.components.embed,
      baseHit.components.keyword,
      keywordScore(haystack, tokens)
    );
    const recency = recencyScore(
      typeof meta["asof"] === "string" ? meta["asof"] : exp.validFrom,
      this.now()
    );

    const tier =
      typeof meta["memoryTier"] === "string"
        ? meta["memoryTier"]
        : exp.subKind === "factor_archive" || exp.subKind === "strategy_recipe"
          ? "deep"
          : "intermediate";
    const tierBase = TIER_IMPORTANCE[tier] ?? 0.5;
    const importance = Math.min(1, tierBase * (0.5 + 0.5 * exp.qualityScore));

    const use = Math.max(exp.useCount, 1);
    const successRate = exp.successCount / use;
    const outcomeWeight = computeOutcomeWeight(exp, successRate);

    if (
      typeof (meta["decisionRecord"] as { outcome?: { brierContribution?: number } } | undefined)
        ?.outcome?.brierContribution === "number"
    ) {
      const brier = Number(
        (meta["decisionRecord"] as { outcome: { brierContribution: number } }).outcome
          .brierContribution
      );
      incContextMetric("finance.decision_brier", Math.round(brier * 1000));
    }

    let domainBoost = 0;
    if (symbols?.length) {
      const tagSyms = exp.tagsJson
        .filter((t) => t.startsWith("symbol:"))
        .map((t) => t.slice("symbol:".length).toUpperCase());
      const metaSyms = Array.isArray(meta["symbols"])
        ? (meta["symbols"] as unknown[]).map((s) => String(s).toUpperCase())
        : [];
      const all = new Set([...tagSyms, ...metaSyms]);
      if (symbols.some((s) => all.has(s.toUpperCase()))) domainBoost += 0.6;
    }
    if (exp.subKind === "factor_archive") {
      const ric = Math.abs(Number(meta["rankIc"] ?? meta["ic"] ?? 0));
      if (Number.isFinite(ric)) domainBoost += Math.min(0.4, ric * 2);
    }
    domainBoost = Math.min(1, domainBoost);

    const score =
      W_REL * relevancy +
      W_REC * recency +
      W_IMP * importance +
      W_OUT * outcomeWeight +
      W_DOM * domainBoost;

    return {
      experience: exp,
      score,
      components: {
        keyword: baseHit.components.keyword,
        quality: exp.qualityScore,
        recency,
        embed: baseHit.components.embed,
        importance,
        outcomeWeight,
        domainBoost,
      },
      rank: -1,
      viaLink: baseHit.viaLink,
      viaEmbed: baseHit.viaEmbed,
    };
  }
}

/** 渲染 `## Memory · Finance Recall` */
export function renderFinanceRecallBlockForPrompt(results: FinanceRecallResult[]): string {
  if (results.length === 0) return "";
  const lines: string[] = ["## Memory · Finance Recall"];
  lines.push(
    "> 金融结构化记忆（带业务 ref / asof）。优先复用；冲突条目并列展示，勿静默丢弃。"
  );
  lines.push("");
  for (const r of results) {
    const exp = r.experience;
    const meta = exp.metadataJson ?? {};
    const kindBadge = `[${exp.kind}/${exp.subKind}]`;
    const refs: string[] = [];
    if (meta["factorId"]) refs.push(`factorId=${meta["factorId"]}`);
    if (meta["compositionId"]) refs.push(`compositionId=${meta["compositionId"]}`);
    if (meta["asof"]) refs.push(`asof=${meta["asof"]}`);
    const metric = `score=${r.score.toFixed(3)} out=${r.components.outcomeWeight.toFixed(2)} q=${exp.qualityScore.toFixed(2)}`;
    lines.push(`### ${kindBadge} ${truncate(exp.contentJson.summary, 90)}`);
    lines.push(`> ${metric}${refs.length ? ` · ${refs.join(" · ")}` : ""}`);
    if (exp.contentJson.body) {
      lines.push(truncate(String(exp.contentJson.body), 280));
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/**
 * A4：有 DecisionRecord.outcome 时用真实后验；否则 quality×successRate 代理。
 * success → 偏高权重（1−brier）；fail → 压低；partial → 中性偏低。
 */
export function computeOutcomeWeight(exp: Experience, successRateFallback: number): number {
  const meta = exp.metadataJson ?? {};
  const dr = meta["decisionRecord"];
  if (dr && typeof dr === "object") {
    const record = dr as {
      confidence?: number;
      outcome?: { label?: string; brierContribution?: number };
    };
    const outcome = record.outcome;
    if (outcome?.label === "success" || outcome?.label === "fail") {
      const conf =
        typeof record.confidence === "number" && Number.isFinite(record.confidence)
          ? Math.max(0, Math.min(1, record.confidence))
          : 0.7;
      const y = outcome.label === "success" ? 1 : 0;
      const brier =
        typeof outcome.brierContribution === "number" && Number.isFinite(outcome.brierContribution)
          ? outcome.brierContribution
          : (conf - y) ** 2;
      const calibrated = Math.max(0, Math.min(1, 1 - brier));
      if (outcome.label === "success") return Math.max(0.35, calibrated);
      return Math.min(0.4, Math.max(0.05, calibrated * 0.5));
    }
    if (outcome?.label === "partial") return 0.45;
    if (outcome?.label === "unknown") return 0.35;
  }
  return Math.min(
    1,
    0.4 * exp.qualityScore + 0.6 * (Number.isFinite(successRateFallback) ? successRateFallback : 0.5)
  );
}
